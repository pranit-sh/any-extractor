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

/**
 * Parser for `.xlsx` (Office Open XML spreadsheet) files.
 *
 * Emits one `sheet` section per worksheet (in workbook order), labeled with
 * the sheet name from `xl/workbook.xml`. Drawing text and chart labels are
 * appended to their sheet. Embedded images are attached to their sheet's
 * section and, when {@link ExtractorConfig.onImage} is set, their OCR text
 * is inlined into `section.text`.
 */
export class ExcelParser implements FileParser {
  readonly mimes = ['application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'] as const;

  async parse(file: Buffer, context: ParserContext): Promise<ParserResult> {
    const sheetRegex = /^xl\/worksheets\/sheet(\d+)\.xml$/;
    const drawingRegex = /^xl\/drawings\/drawing\d+\.xml$/;
    const chartRegex = /^xl\/charts\/chart\d+\.xml$/;
    const imageRegex = /^xl\/media\/image\d+\.(png|jpe?g|webp|gif|bmp)$/i;
    const workbookRegex = /^xl\/workbook\.xml$/;
    const sharedStringsPath = 'xl/sharedStrings.xml';
    const coreRegex = /^docProps\/core\.xml$/;

    const files = await extractFiles(
      file,
      (path) =>
        sheetRegex.test(path) ||
        drawingRegex.test(path) ||
        chartRegex.test(path) ||
        imageRegex.test(path) ||
        workbookRegex.test(path) ||
        coreRegex.test(path) ||
        path === sharedStringsPath,
    );

    const sheetFiles = files.filter((f) => sheetRegex.test(f.path));
    if (sheetFiles.length === 0) {
      throw new Error('any-extractor: xlsx is missing worksheet files');
    }

    const sharedStrings = parseSharedStrings(
      files.find((f) => f.path === sharedStringsPath)?.content.toString(),
    );

    const workbookXml = files.find((f) => workbookRegex.test(f.path))?.content.toString();
    const sheetNamesByIndex = parseSheetNames(workbookXml);
    const coreXml = files.find((f) => coreRegex.test(f.path))?.content.toString();

    // Auxiliary content that's not clearly tied to a sheet — for now, append
    // to the last sheet section.
    const drawingText = files
      .filter((f) => drawingRegex.test(f.path))
      .map((f) => extractDrawingText(f.content.toString()))
      .filter(Boolean)
      .join('\n');
    const chartText = files
      .filter((f) => chartRegex.test(f.path))
      .map((f) => extractChartText(f.content.toString()))
      .filter(Boolean)
      .join('\n');

    const onImage = context.config.onImage;
    const imageEntries: ExtractedImage[] = [];
    let inlineImages = '';
    for (const f of files) {
      if (!imageRegex.test(f.path)) continue;
      const mime = guessImageMime(f.path);
      const entry: ExtractedImage = { mime, path: f.path, bytes: f.content.length };
      if (onImage) {
        try {
          const description = await onImage(f.content, mime);
          if (description) {
            entry.description = description;
            inlineImages += (inlineImages ? '\n' : '') + description;
          }
        } catch {
          // swallow — consistent policy across parsers.
        }
      }
      imageEntries.push(entry);
    }

    // Sort sheets numerically by their filename index.
    sheetFiles.sort((a, b) => sheetIndex(a.path) - sheetIndex(b.path));

    const sections: Section[] = sheetFiles.map((f, i) => {
      const idx = sheetIndex(f.path);
      const name = sheetNamesByIndex[idx - 1];
      const text = extractSheetText(f.content.toString(), sharedStrings);
      const label = name ? `Sheet: ${name}` : `Sheet ${idx}`;
      return {
        kind: 'sheet',
        index: i + 1,
        label,
        text,
      };
    });

    // Attach drawing/chart/image content to the last sheet so nothing is lost.
    const extras = [drawingText, chartText, inlineImages].filter(Boolean).join('\n');
    if (sections.length && extras) {
      const last = sections[sections.length - 1];
      last.text = last.text ? `${last.text}\n${extras}` : extras;
    }
    if (sections.length && imageEntries.length) {
      const last = sections[sections.length - 1];
      last.images = imageEntries;
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

function parseCoreProperties(xml: string): Partial<ExtractMetadata> {
  const doc = parseXml(xml);
  const get = (tag: string) => {
    const el = doc.getElementsByTagName(tag)[0];
    const v = el?.childNodes[0]?.nodeValue?.trim();
    return v || undefined;
  };
  const created = get('dcterms:created');
  const modified = get('dcterms:modified');
  const keywords = get('cp:keywords');
  return {
    title: get('dc:title'),
    author: get('dc:creator'),
    subject: get('dc:subject'),
    language: get('dc:language'),
    keywords: keywords
      ? keywords
          .split(/[,;]/)
          .map((k) => k.trim())
          .filter(Boolean)
      : undefined,
    createdAt: created ? new Date(created) : undefined,
    modifiedAt: modified ? new Date(modified) : undefined,
  };
}

function guessImageMime(path: string): string {
  const ext = path.split('.').pop()?.toLowerCase() ?? '';
  const map: Record<string, string> = {
    png: 'image/png',
    jpg: 'image/jpeg',
    jpeg: 'image/jpeg',
    gif: 'image/gif',
    webp: 'image/webp',
    bmp: 'image/bmp',
  };
  return map[ext] ?? 'application/octet-stream';
}
