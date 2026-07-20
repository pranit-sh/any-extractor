import type { Element } from '@xmldom/xmldom';
import type {
  ExtractMetadata,
  ExtractedImage,
  FileParser,
  ParserContext,
  ParserResult,
  Section,
} from '../types';
import { extractFiles, parseXml } from '../util';
import { guessImageMime, parseCoreProperties } from './ooxml-utils';

/**
 * Parser for `.xlsx` (Office Open XML spreadsheet) files.
 *
 * Emits one `sheet` section per worksheet (in workbook order), labeled with
 * the sheet name from `xl/workbook.xml`. Drawing text, chart labels, and
 * embedded images are attributed to their owning sheet via the workbook's
 * relationship graph.
 *
 * If {@link ExtractorConfig.onImage} is set, its return value is stored on
 * `image.description` — it is NOT inlined into `section.text`.
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
    const sheetNamesByIndex = parseSheetNames(workbookXml);
    const coreXml = files.find((f) => coreRegex.test(f.path))?.content.toString();

    const onImage = context.config.onImage;
    sheetFiles.sort((a, b) => sheetIndex(a.path) - sheetIndex(b.path));

    const sections: Section[] = [];
    for (let i = 0; i < sheetFiles.length; i++) {
      const sheet = sheetFiles[i];
      const idx = sheetIndex(sheet.path);
      const name = sheetNamesByIndex[idx - 1];

      const parts: string[] = [];
      const cellText = extractSheetText(sheet.content.toString(), sharedStrings);
      if (cellText) parts.push(cellText);

      // Follow sheet -> drawing -> images/charts via relationships.
      const sheetRelsPath = `xl/worksheets/_rels/sheet${idx}.xml.rels`;
      const drawingPaths = resolveDrawingPaths(byPath.get(sheetRelsPath)?.content.toString());

      const images: ExtractedImage[] = [];
      for (const drawingPath of drawingPaths) {
        const drawing = byPath.get(drawingPath);
        if (!drawing) continue;
        const t = extractDrawingText(drawing.content.toString());
        if (t) parts.push(t);

        const drawingRelsPath = drawingPath.replace(
          /^xl\/drawings\/([^/]+)$/,
          'xl/drawings/_rels/$1.rels',
        );
        const rels = parseDrawingRels(byPath.get(drawingRelsPath)?.content.toString(), drawingPath);
        for (const chartPath of rels.charts) {
          const chart = byPath.get(chartPath);
          if (chart) {
            const c = extractChartText(chart.content.toString());
            if (c) parts.push(c);
          }
        }
        for (const imgPath of rels.images) {
          const img = byPath.get(imgPath);
          if (!img) continue;
          const mime = guessImageMime(imgPath);
          const entry: ExtractedImage = { mime, path: imgPath, bytes: img.content.length };
          if (onImage) {
            try {
              const description = await onImage(img.content, mime);
              if (description) entry.description = description;
            } catch {
              // Swallow — consistent policy across parsers.
            }
          }
          images.push(entry);
        }
      }

      sections.push({
        kind: 'sheet',
        index: i + 1,
        label: name ? `Sheet: ${name}` : `Sheet ${idx}`,
        text: parts.join('\n'),
        ...(images.length ? { images } : {}),
      });
    }

    const metadata: Partial<ExtractMetadata> = {
      sheetNames: sheetNamesByIndex.filter(Boolean),
      ...(coreXml ? parseCoreProperties(coreXml) : {}),
    };

    return { sections, metadata };
  }
}

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

/** Given a sheetN.xml.rels body, return the drawing xml paths it references. */
function resolveDrawingPaths(xml: string | undefined): string[] {
  if (!xml) return [];
  const rels = parseXml(xml).getElementsByTagName('Relationship');
  const out: string[] = [];
  for (const r of Array.from(rels)) {
    const type = r.getAttribute('Type') ?? '';
    const target = r.getAttribute('Target');
    if (!target || !type.includes('/drawing')) continue;
    // Targets are relative to xl/worksheets — e.g. "../drawings/drawing1.xml".
    out.push(normalize(`xl/worksheets/${target}`));
  }
  return out;
}

/** Given a drawing rels body, return the chart & image paths it references. */
function parseDrawingRels(
  xml: string | undefined,
  drawingPath: string,
): { charts: string[]; images: string[] } {
  const result = { charts: [] as string[], images: [] as string[] };
  if (!xml) return result;
  const rels = parseXml(xml).getElementsByTagName('Relationship');
  const base = drawingPath.replace(/[^/]+$/, ''); // "xl/drawings/"
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

/** Collapse "a/b/../c" to "a/c". */
function normalize(path: string): string {
  const parts: string[] = [];
  for (const seg of path.split('/')) {
    if (seg === '..') parts.pop();
    else if (seg && seg !== '.') parts.push(seg);
  }
  return parts.join('/');
}

function extractSheetText(xml: string, sharedStrings: string[]): string {
  const cNodes = parseXml(xml).getElementsByTagName('c');
  return Array.from(cNodes)
    .filter((n) => isInlineString(n) || hasValueNode(n))
    .map((n) => getCellValue(n, sharedStrings))
    .join('\n');
}

function extractDrawingText(xml: string): string {
  const pNodes = parseXml(xml).getElementsByTagName('a:p');
  return Array.from(pNodes)
    .map((p) =>
      Array.from(p.getElementsByTagName('a:t'))
        .map((t) => t.childNodes[0]?.nodeValue ?? '')
        .join(''),
    )
    .join('\n');
}

function extractChartText(xml: string): string {
  const vNodes = parseXml(xml).getElementsByTagName('c:v');
  return Array.from(vNodes)
    .map((n) => n.childNodes[0]?.nodeValue ?? '')
    .join('\n');
}

function isInlineString(node: Element): boolean {
  if (node.tagName.toLowerCase() !== 'c' || node.getAttribute('t') !== 'inlineStr') return false;
  const is = node.getElementsByTagName('is')[0];
  return is?.getElementsByTagName('t')[0]?.childNodes[0]?.nodeValue !== undefined;
}

function hasValueNode(node: Element): boolean {
  return node.getElementsByTagName('v')[0]?.childNodes[0]?.nodeValue !== undefined;
}

function getCellValue(node: Element, sharedStrings: string[]): string {
  if (isInlineString(node)) {
    return (
      node.getElementsByTagName('is')[0].getElementsByTagName('t')[0].childNodes[0].nodeValue ?? ''
    );
  }
  if (!hasValueNode(node)) return '';
  const isShared = node.getAttribute('t') === 's';
  const raw = node.getElementsByTagName('v')[0].childNodes[0].nodeValue ?? '';
  if (isShared) {
    const idx = parseInt(raw, 10);
    if (idx < 0 || idx >= sharedStrings.length) {
      throw new Error('any-extractor: invalid shared string index in xlsx');
    }
    return sharedStrings[idx];
  }
  return raw;
}
