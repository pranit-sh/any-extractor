import type { Element } from '@xmldom/xmldom';
import { makeSection } from '../blocks';
import type {
  Block,
  ExtractMetadata,
  FileParser,
  ParserContext,
  ParserResult,
  Section,
} from '../types';
import { extractFiles, parseXml } from '../util';
import { parseCoreProperties } from './ooxml-utils';

/**
 * Parser for `.xlsx` workbooks. Emits one {@link Section} per worksheet
 * (`kind: 'sheet'`) with a single {@link Table} block per sheet.
 *
 * Handles merged cells by "fanning out" the merged value across all
 * covered cells so downstream consumers never see empty holes.
 */
export class ExcelParser implements FileParser {
  readonly mimes = ['application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'] as const;

  async parse(file: Buffer, ctx: ParserContext): Promise<ParserResult> {
    const files = await extractFiles(file, (path) =>
      /^xl\/(workbook\.xml|sharedStrings\.xml|worksheets\/sheet\d+\.xml|_rels\/workbook\.xml\.rels)$|^docProps\/core\.xml$/.test(
        path,
      ),
    );

    const workbookFile = files.find((f) => f.path === 'xl/workbook.xml');
    const relsFile = files.find((f) => f.path === 'xl/_rels/workbook.xml.rels');
    const stringsFile = files.find((f) => f.path === 'xl/sharedStrings.xml');
    const coreFile = files.find((f) => f.path === 'docProps/core.xml');
    if (!workbookFile || !relsFile) {
      throw new Error('any-extractor: xlsx is missing workbook or relationships');
    }

    const strings = stringsFile ? parseSharedStrings(stringsFile.content.toString()) : [];
    const sheetOrder = parseWorkbookSheets(
      workbookFile.content.toString(),
      relsFile.content.toString(),
    );

    const sections: Section[] = [];
    const sheetNames: string[] = [];

    for (let i = 0; i < sheetOrder.length; i++) {
      const { name, target } = sheetOrder[i];
      sheetNames.push(name);
      const sheetFile = files.find((f) => f.path === `xl/${target}`);
      if (!sheetFile) continue;

      const grid = extractSheetGrid(sheetFile.content.toString(), strings);
      if (grid.length === 0) continue;

      const [headers, ...body] = grid;
      const blocks: Block[] = [ctx.block.table(body, { headers, sectionPath: [name] })];
      sections.push(makeSection('sheet', blocks, { index: i + 1, label: name }));
    }

    const metadata: Partial<ExtractMetadata> = {
      ...(coreFile ? parseCoreProperties(coreFile.content.toString()) : {}),
      sheetNames,
    };

    return { sections, metadata };
  }
}

// ---------------------------------------------------------------------------
// Workbook / sheet plumbing
// ---------------------------------------------------------------------------

function parseSharedStrings(xml: string): string[] {
  const doc = parseXml(xml);
  const out: string[] = [];
  for (const si of Array.from(doc.getElementsByTagName('si'))) {
    const parts = Array.from(si.getElementsByTagName('t')).map(
      (t) => t.childNodes[0]?.nodeValue ?? '',
    );
    out.push(parts.join(''));
  }
  return out;
}

interface SheetRef {
  name: string;
  target: string;
}

function parseWorkbookSheets(workbookXml: string, relsXml: string): SheetRef[] {
  const wb = parseXml(workbookXml);
  const rels = parseXml(relsXml);
  const relMap: Record<string, string> = {};
  for (const rel of Array.from(rels.getElementsByTagName('Relationship'))) {
    const id = rel.getAttribute('Id');
    const target = rel.getAttribute('Target');
    if (id && target) relMap[id] = target;
  }
  const out: SheetRef[] = [];
  for (const sheet of Array.from(wb.getElementsByTagName('sheet'))) {
    const name = sheet.getAttribute('name') ?? '';
    const rId = sheet.getAttribute('r:id') ?? '';
    const target = relMap[rId];
    if (name && target) out.push({ name, target });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Sheet → 2D grid (with merge fan-out)
// ---------------------------------------------------------------------------

function extractSheetGrid(xml: string, strings: string[]): string[][] {
  const doc = parseXml(xml);
  const rows = Array.from(doc.getElementsByTagName('row'));
  const grid: string[][] = [];
  let maxCol = 0;

  for (const row of rows) {
    const r = Number(row.getAttribute('r') ?? '0');
    if (!r) continue;
    while (grid.length < r) grid.push([]);
    const cells = Array.from(row.getElementsByTagName('c'));
    for (const cell of cells) {
      const ref = cell.getAttribute('r') ?? '';
      const { col } = parseRef(ref);
      if (col < 0) continue;
      const value = readCellValue(cell, strings);
      const rowArr = grid[r - 1];
      while (rowArr.length <= col) rowArr.push('');
      rowArr[col] = value;
      if (col + 1 > maxCol) maxCol = col + 1;
    }
  }

  // Fan-out merges.
  const mergeEl = doc.getElementsByTagName('mergeCells')[0];
  if (mergeEl) {
    for (const merge of Array.from(mergeEl.getElementsByTagName('mergeCell'))) {
      const range = merge.getAttribute('ref');
      if (!range) continue;
      const [start, end] = range.split(':');
      const s = parseRef(start);
      const e = parseRef(end);
      if (s.row < 0 || e.row < 0) continue;
      while (grid.length <= e.row) grid.push([]);
      const value = grid[s.row]?.[s.col] ?? '';
      for (let r = s.row; r <= e.row; r++) {
        const rowArr = grid[r];
        while (rowArr.length <= e.col) rowArr.push('');
        for (let c = s.col; c <= e.col; c++) rowArr[c] = value;
      }
      if (e.col + 1 > maxCol) maxCol = e.col + 1;
    }
  }

  // Normalize to a rectangular grid and drop trailing all-empty rows.
  for (const r of grid) {
    while (r.length < maxCol) r.push('');
  }
  while (grid.length && grid[grid.length - 1].every((c) => c === '')) grid.pop();
  return grid;
}

function readCellValue(cell: Element, strings: string[]): string {
  const type = cell.getAttribute('t') ?? '';
  const vEl = cell.getElementsByTagName('v')[0];
  const isEl = cell.getElementsByTagName('is')[0];
  if (type === 's') {
    const idx = Number(vEl?.childNodes[0]?.nodeValue ?? -1);
    return strings[idx] ?? '';
  }
  if (type === 'inlineStr' && isEl) {
    return Array.from(isEl.getElementsByTagName('t'))
      .map((t) => t.childNodes[0]?.nodeValue ?? '')
      .join('');
  }
  return vEl?.childNodes[0]?.nodeValue ?? '';
}

function parseRef(ref: string): { row: number; col: number } {
  const m = /^([A-Z]+)(\d+)$/.exec(ref);
  if (!m) return { row: -1, col: -1 };
  const letters = m[1];
  const row = Number(m[2]) - 1;
  let col = 0;
  for (const ch of letters) col = col * 26 + (ch.charCodeAt(0) - 64);
  return { row, col: col - 1 };
}
