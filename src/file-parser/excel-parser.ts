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
import { guessImageMime, parseCoreProperties } from './ooxml-utils';

/**
 * Parser for `.xlsx` files.
 *
 * Emits one `sheet` section per worksheet. Each sheet becomes a
 * {@link TableBlock} with column headers (from the first row) and body rows.
 * Drawing text, chart labels, and images are appended as extra blocks on the
 * same section.
 */
export class ExcelParser implements FileParser {
  readonly mimes = ['application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'] as const;

  async parse(file: Buffer, context: ParserContext): Promise<ParserResult> {
    const sheetRegex = /^xl\/worksheets\/sheet(\d+)\.xml$/;
    const sheetRelsRegex = /^xl\/worksheets\/_rels\/sheet(\d+)\.xml\.rels$/;
    const drawingRegex = /^xl\/drawings\/drawing\d+\.xml$/;
    const drawingRelsRegex = /^xl\/drawings\/_rels\/drawing\d+\.xml\.rels$/;
    const chartRegex = /^xl\/charts\/chart\d+\.xml$/;
    const imageRegex = /^xl\/media\/image\d+\.(png|jpe?g|webp|gif|bmp)$/i;
    const workbookRegex = /^xl\/workbook\.xml$/;
    const sharedStringsPath = 'xl/sharedStrings.xml';
    const coreRegex = /^docProps\/core\.xml$/;

    const files = await extractFiles(
      file,
      (path) =>
        sheetRegex.test(path) ||
        sheetRelsRegex.test(path) ||
        drawingRegex.test(path) ||
        drawingRelsRegex.test(path) ||
        chartRegex.test(path) ||
        imageRegex.test(path) ||
        workbookRegex.test(path) ||
        coreRegex.test(path) ||
        path === sharedStringsPath,
    );

    const byPath = new Map(files.map((f) => [f.path, f]));
    const sheetFiles = files.filter((f) => sheetRegex.test(f.path));
    if (sheetFiles.length === 0) {
      throw new Error('any-extractor: xlsx is missing worksheet files');
    }

    const sharedStrings = parseSharedStrings(byPath.get(sharedStringsPath)?.content.toString());
    const workbookXml = files.find((f) => workbookRegex.test(f.path))?.content.toString();
    const sheetNames = parseSheetNames(workbookXml);
    const coreXml = files.find((f) => coreRegex.test(f.path))?.content.toString();

    sheetFiles.sort((a, b) => sheetIndex(a.path) - sheetIndex(b.path));

    const sections: Section[] = [];
    for (let i = 0; i < sheetFiles.length; i++) {
      const sheet = sheetFiles[i];
      const idx = sheetIndex(sheet.path);
      const name = sheetNames[idx - 1] ?? `Sheet ${idx}`;

      const grid = extractSheetGrid(sheet.content.toString(), sharedStrings);
      const blocks: Block[] = [];

      if (grid.rows.length > 0) {
        const [headerRow, ...bodyRows] = grid.rows;
        const headers = headerRow.map((c) => String(c ?? ''));
        const rowsAsStrings = bodyRows.map((r) => r.map((c) => (c == null ? '' : String(c))));
        blocks.push(
          context.block.table(rowsAsStrings, {
            headers,
            raw: bodyRows,
            sectionPath: [name],
          }),
        );
      }

      // Attach drawing text / chart labels as paragraphs so nothing is lost.
      const sheetRelsPath = `xl/worksheets/_rels/sheet${idx}.xml.rels`;
      const drawingPaths = resolveDrawingPaths(byPath.get(sheetRelsPath)?.content.toString());

      for (const drawingPath of drawingPaths) {
        const drawing = byPath.get(drawingPath);
        if (!drawing) continue;
        const drawingText = extractDrawingText(drawing.content.toString());
        if (drawingText) {
          blocks.push(context.block.paragraph(drawingText, { sectionPath: [name] }));
        }

        const drawingRelsPath = drawingPath.replace(
          /^xl\/drawings\/([^/]+)$/,
          'xl/drawings/_rels/$1.rels',
        );
        const rels = parseDrawingRels(byPath.get(drawingRelsPath)?.content.toString(), drawingPath);

        for (const chartPath of rels.charts) {
          const chart = byPath.get(chartPath);
          if (!chart) continue;
          const chartText = extractChartText(chart.content.toString());
          if (chartText) {
            blocks.push(context.block.paragraph(chartText, { sectionPath: [name] }));
          }
        }

        for (const imgPath of rels.images) {
          const img = byPath.get(imgPath);
          if (!img) continue;
          const mime = guessImageMime(imgPath);
          const description = (await context.describe(img.content)) || undefined;
          blocks.push(
            context.block.image(
              { mime, path: imgPath, bytes: img.content.length, description },
              { sectionPath: [name] },
            ),
          );
        }
      }

      sections.push(
        makeSection('sheet', blocks, {
          index: i + 1,
          label: `Sheet: ${name}`,
          sectionPath: [name],
        }),
      );
    }

    const metadata: Partial<ExtractMetadata> = {
      sheetNames: sheetNames.filter(Boolean),
      ...(coreXml ? parseCoreProperties(coreXml) : {}),
    };

    return { sections, metadata };
  }
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

function sheetIndex(path: string): number {
  const m = path.match(/sheet(\d+)\.xml$/);
  return m ? +m[1] : 0;
}

function parseSharedStrings(xml?: string): string[] {
  if (!xml) return [];
  const tNodes = parseXml(xml).getElementsByTagName('t');
  return Array.from(tNodes).map((n) => n.childNodes[0]?.nodeValue ?? '');
}

function parseSheetNames(xml?: string): string[] {
  if (!xml) return [];
  const nodes = parseXml(xml).getElementsByTagName('sheet');
  return Array.from(nodes).map((n) => n.getAttribute('name') ?? '');
}

function resolveDrawingPaths(xml: string | undefined): string[] {
  if (!xml) return [];
  const rels = parseXml(xml).getElementsByTagName('Relationship');
  const out: string[] = [];
  for (const r of Array.from(rels)) {
    const type = r.getAttribute('Type') ?? '';
    const target = r.getAttribute('Target');
    if (!target || !type.includes('/drawing')) continue;
    out.push(normalize(`xl/worksheets/${target}`));
  }
  return out;
}

function parseDrawingRels(
  xml: string | undefined,
  drawingPath: string,
): { charts: string[]; images: string[] } {
  const result = { charts: [] as string[], images: [] as string[] };
  if (!xml) return result;
  const rels = parseXml(xml).getElementsByTagName('Relationship');
  const base = drawingPath.replace(/[^/]+$/, '');
  for (const r of Array.from(rels)) {
    const type = r.getAttribute('Type') ?? '';
    const target = r.getAttribute('Target');
    if (!target) continue;
    const resolved = normalize(base + target);
    if (type.includes('/chart')) result.charts.push(resolved);
    else if (type.includes('/image')) result.images.push(resolved);
  }
  return result;
}

function normalize(path: string): string {
  const parts: string[] = [];
  for (const seg of path.split('/')) {
    if (seg === '..') parts.pop();
    else if (seg && seg !== '.') parts.push(seg);
  }
  return parts.join('/');
}

/**
 * Build a 2D grid from a worksheet, honoring cell references so gaps are
 * preserved as empty cells. Returns typed values where possible.
 */
function extractSheetGrid(xml: string, sharedStrings: string[]): { rows: unknown[][] } {
  const rowNodes = parseXml(xml).getElementsByTagName('row');
  const rows: unknown[][] = [];
  for (const rowNode of Array.from(rowNodes)) {
    const cells = Array.from(rowNode.getElementsByTagName('c'));
    const row: unknown[] = [];
    for (const cell of cells) {
      const col = columnIndex(cell.getAttribute('r'));
      while (row.length < col) row.push('');
      row.push(getTypedCellValue(cell, sharedStrings));
    }
    rows.push(row);
  }
  return { rows };
}

function columnIndex(ref: string | null): number {
  if (!ref) return 0;
  const m = ref.match(/^([A-Z]+)/);
  if (!m) return 0;
  let n = 0;
  for (const ch of m[1]) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n - 1;
}

function getTypedCellValue(node: Element, sharedStrings: string[]): unknown {
  const t = node.getAttribute('t');
  if (t === 'inlineStr') {
    return (
      node.getElementsByTagName('is')[0]?.getElementsByTagName('t')[0]?.childNodes[0]?.nodeValue ??
      ''
    );
  }
  const v = node.getElementsByTagName('v')[0]?.childNodes[0]?.nodeValue;
  if (v == null) return '';
  if (t === 's') {
    const idx = parseInt(v, 10);
    return sharedStrings[idx] ?? '';
  }
  if (t === 'b') return v === '1';
  if (t === 'str' || t === 'e') return v;
  const n = Number(v);
  return Number.isFinite(n) ? n : v;
}

function extractDrawingText(xml: string): string {
  const pNodes = parseXml(xml).getElementsByTagName('a:p');
  return Array.from(pNodes)
    .map((p) =>
      Array.from(p.getElementsByTagName('a:t'))
        .map((t) => t.childNodes[0]?.nodeValue ?? '')
        .join(''),
    )
    .filter(Boolean)
    .join('\n');
}

function extractChartText(xml: string): string {
  const vNodes = parseXml(xml).getElementsByTagName('c:v');
  return Array.from(vNodes)
    .map((n) => n.childNodes[0]?.nodeValue ?? '')
    .filter(Boolean)
    .join(' · ');
}
