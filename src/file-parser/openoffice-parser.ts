import type { Element } from '@xmldom/xmldom';
import { makeSection } from '../blocks';
import type {
  Block,
  BlockPos,
  ExtractedFile,
  ExtractMetadata,
  FileParser,
  ParserContext,
  ParserResult,
  Section,
} from '../types';
import { extractFiles, parseXml } from '../util';
import { guessImageMime } from './ooxml-utils';

/**
 * Parser for OpenDocument formats: `.odt` (text), `.ods` (spreadsheet),
 * and `.odp` (presentation).
 *
 * ODT → single `body` section.
 * ODS → one `sheet` section per table.
 * ODP → one `slide` section per drawing page.
 */
export class OpenOfficeParser implements FileParser {
  readonly mimes = [
    'application/vnd.oasis.opendocument.text',
    'application/vnd.oasis.opendocument.spreadsheet',
    'application/vnd.oasis.opendocument.presentation',
  ] as const;

  async parse(file: Buffer, ctx: ParserContext): Promise<ParserResult> {
    const files = await extractFiles(
      file,
      (path) => path === 'content.xml' || path === 'meta.xml' || path.startsWith('Pictures/'),
    );
    const contentFile = files.find((f) => f.path === 'content.xml');
    if (!contentFile) {
      throw new Error('any-extractor: OpenDocument archive is missing content.xml');
    }
    const metaFile = files.find((f) => f.path === 'meta.xml');
    const pictures: Record<string, ExtractedFile> = {};
    for (const f of files) if (f.path.startsWith('Pictures/')) pictures[f.path] = f;

    const doc = parseXml(contentFile.content.toString());
    const body = doc.getElementsByTagName('office:body')[0];
    if (!body) return { sections: [] };

    const kind = detectKind(body);
    const sections =
      kind === 'text'
        ? extractText(body, pictures, ctx)
        : kind === 'spreadsheet'
          ? extractSpreadsheet(body, ctx)
          : kind === 'presentation'
            ? extractPresentation(body, pictures, ctx)
            : [];

    const metadata = metaFile ? parseMeta(metaFile.content.toString()) : {};
    return { sections, metadata };
  }
}

function detectKind(body: Element): 'text' | 'spreadsheet' | 'presentation' | 'unknown' {
  if (body.getElementsByTagName('office:text').length > 0) return 'text';
  if (body.getElementsByTagName('office:spreadsheet').length > 0) return 'spreadsheet';
  if (body.getElementsByTagName('office:presentation').length > 0) return 'presentation';
  return 'unknown';
}

function parseMeta(xml: string): Partial<ExtractMetadata> {
  const doc = parseXml(xml);
  const get = (tag: string): string | undefined => {
    const el = doc.getElementsByTagName(tag)[0];
    const v = el?.childNodes[0]?.nodeValue?.trim();
    return v || undefined;
  };
  const out: Partial<ExtractMetadata> = {};
  const title = get('dc:title');
  if (title) out.title = title;
  const author = get('dc:creator') ?? get('meta:initial-creator');
  if (author) out.author = author;
  return out;
}

// ---------------------------------------------------------------------------
// ODT (text)
// ---------------------------------------------------------------------------

function extractText(
  body: Element,
  pictures: Record<string, ExtractedFile>,
  ctx: ParserContext,
): Section[] {
  const officeText = body.getElementsByTagName('office:text')[0];
  if (!officeText) return [];
  const blocks: Block[] = [];
  const headingStack: string[] = [];

  const currentPos = (): BlockPos =>
    headingStack.length ? { sectionPath: [...headingStack] } : {};

  const children = Array.from(officeText.childNodes).filter((n) => n.nodeType === 1) as Element[];
  for (const el of children) {
    if (el.tagName === 'text:h') {
      const level = Math.min(6, Math.max(1, Number(el.getAttribute('text:outline-level') ?? '1')));
      const text = textOf(el).trim();
      if (!text) continue;
      while (headingStack.length >= level) headingStack.pop();
      blocks.push(ctx.block.heading(level as 1 | 2 | 3 | 4 | 5 | 6, text, currentPos()));
      headingStack.push(text);
    } else if (el.tagName === 'text:p') {
      const text = textOf(el).trim();
      if (text) blocks.push(ctx.block.paragraph(text, currentPos()));
      collectImages(el, pictures, ctx, blocks, currentPos());
    } else if (el.tagName === 'text:list') {
      const items = readList(el);
      if (items.length) blocks.push(ctx.block.list(items, currentPos()));
    } else if (el.tagName === 'table:table') {
      const rows = readOdfTable(el);
      if (rows.length) {
        blocks.push(ctx.block.table(rows.slice(1), { headers: rows[0], ...currentPos() }));
      }
    }
  }

  return blocks.length ? [makeSection('body', blocks)] : [];
}

function readList(list: Element): string[] {
  const items: string[] = [];
  for (const item of Array.from(list.getElementsByTagName('text:list-item'))) {
    const text = textOf(item).trim();
    if (text) items.push(text);
  }
  return items;
}

function readOdfTable(tbl: Element): string[][] {
  const rows: string[][] = [];
  for (const tr of Array.from(tbl.getElementsByTagName('table:table-row'))) {
    const row: string[] = [];
    for (const tc of Array.from(tr.getElementsByTagName('table:table-cell'))) {
      row.push(textOf(tc).trim());
    }
    if (row.length) rows.push(row);
  }
  return rows;
}

function collectImages(
  el: Element,
  pictures: Record<string, ExtractedFile>,
  ctx: ParserContext,
  out: Block[],
  pos: BlockPos,
): void {
  for (const image of Array.from(el.getElementsByTagName('draw:image'))) {
    const href = image.getAttribute('xlink:href');
    if (!href) continue;
    const media = pictures[href];
    if (!media) continue;
    const frame = image.parentNode as Element | null;
    const alt = frame ? attrOfFirst(frame, 'svg:desc') : undefined;
    out.push(
      ctx.block.image(
        {
          mime: guessImageMime(media.path),
          path: media.path,
          bytes: media.content.length,
          ...(alt ? { alt } : {}),
        },
        pos,
      ),
    );
  }
}

// ---------------------------------------------------------------------------
// ODS (spreadsheet)
// ---------------------------------------------------------------------------

function extractSpreadsheet(body: Element, ctx: ParserContext): Section[] {
  const spread = body.getElementsByTagName('office:spreadsheet')[0];
  if (!spread) return [];
  const sections: Section[] = [];
  const tables = Array.from(spread.getElementsByTagName('table:table'));
  for (let i = 0; i < tables.length; i++) {
    const tbl = tables[i];
    const name = tbl.getAttribute('table:name') ?? `Sheet${i + 1}`;
    const rows = readOdfSheet(tbl);
    if (rows.length === 0) continue;
    const blocks: Block[] = [
      ctx.block.table(rows.slice(1), { headers: rows[0], sectionPath: [name] }),
    ];
    sections.push(makeSection('sheet', blocks, { index: i + 1, label: name }));
  }
  return sections;
}

function readOdfSheet(tbl: Element): string[][] {
  const rows: string[][] = [];
  for (const tr of Array.from(tbl.getElementsByTagName('table:table-row'))) {
    const row: string[] = [];
    for (const tc of Array.from(tr.getElementsByTagName('table:table-cell'))) {
      const repeat = Number(tc.getAttribute('table:number-columns-repeated') ?? '1') || 1;
      const value = textOf(tc).trim();
      for (let r = 0; r < Math.min(repeat, 1000); r++) row.push(value);
    }
    while (row.length && row[row.length - 1] === '') row.pop();
    if (row.length) rows.push(row);
  }
  return rows;
}

// ---------------------------------------------------------------------------
// ODP (presentation)
// ---------------------------------------------------------------------------

function extractPresentation(
  body: Element,
  pictures: Record<string, ExtractedFile>,
  ctx: ParserContext,
): Section[] {
  const pres = body.getElementsByTagName('office:presentation')[0];
  if (!pres) return [];
  const sections: Section[] = [];
  const pages = Array.from(pres.getElementsByTagName('draw:page'));
  for (let i = 0; i < pages.length; i++) {
    const page = pages[i];
    const name = page.getAttribute('draw:name') ?? `Slide ${i + 1}`;
    const blocks: Block[] = [];
    let titleTaken = false;

    for (const frame of Array.from(page.getElementsByTagName('draw:frame'))) {
      const cls = frame.getAttribute('presentation:class') ?? '';
      const texts = Array.from(frame.getElementsByTagName('text:p'))
        .map((p) => textOf(p).trim())
        .filter(Boolean);
      if (cls === 'title' && !titleTaken && texts[0]) {
        blocks.push(ctx.block.heading(2, texts[0]));
        titleTaken = true;
        for (const t of texts.slice(1)) blocks.push(ctx.block.paragraph(t));
      } else if (texts.length) {
        // If the frame has explicit bullet lists we would surface them;
        // ODP typically uses `<text:list>` here, so we do the same.
        const listEl = frame.getElementsByTagName('text:list')[0];
        if (listEl) {
          const items = readList(listEl);
          if (items.length) blocks.push(ctx.block.list(items, {}));
        } else {
          for (const t of texts) blocks.push(ctx.block.paragraph(t));
        }
      }
      collectImages(frame, pictures, ctx, blocks, {});
    }
    if (blocks.length === 0) continue;
    sections.push(makeSection('slide', blocks, { index: i + 1, label: name }));
  }
  return sections;
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

/** Recursive text extraction that preserves inline line breaks. */
function textOf(el: Element): string {
  return textOfInner(el).replace(/\s+/g, ' ').trim();
}

function textOfInner(el: Element): string {
  let out = '';
  for (const child of Array.from(el.childNodes)) {
    if (child.nodeType === 3) {
      out += child.nodeValue ?? '';
    } else if (child.nodeType === 1) {
      const c = child as Element;
      if (c.tagName === 'text:line-break') out += '\n';
      else out += textOfInner(c);
    }
  }
  return out;
}

/** Return the text content of the first descendant with the given tag. */
function attrOfFirst(root: Element, tag: string): string | undefined {
  const el = root.getElementsByTagName(tag)[0];
  if (!el) return undefined;
  const t = el.childNodes[0]?.nodeValue?.trim();
  return t || undefined;
}
