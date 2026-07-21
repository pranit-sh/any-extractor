import { getDocumentProxy, getMeta } from 'unpdf';
import { makeSection } from '../blocks';
import type {
  Block,
  FileParser,
  ParserContext,
  ParserResult,
  ParserStreamEvent,
  Section,
} from '../types';
import { splitKeywords } from './ooxml-utils';

/**
 * Parser for PDF files. Uses `unpdf` (serverless PDF.js).
 *
 * Emits one {@link Section} per page (`kind: 'page'`). Text items are
 * grouped into lines by y-position, split into columns when a page has a
 * clear horizontal gap, and joined into paragraph blocks on vertical
 * gaps — so multi-column PDFs serialize in a sensible reading order.
 */
export class PDFParser implements FileParser {
  readonly mimes = ['application/pdf'] as const;

  async parse(file: Buffer, ctx: ParserContext): Promise<ParserResult> {
    const sections: Section[] = [];
    let metadata: ParserResult['metadata'] = {};
    for await (const evt of this.parseStream(file, ctx)) {
      if (evt.type === 'section') sections.push(evt.section);
      else if (evt.type === 'metadata') metadata = { ...metadata, ...evt.metadata };
      // parseStream never emits `error` from PDF parsing today (unpdf
      // errors abort the whole document); if it starts to, the batch API
      // will simply drop failed pages, which matches historical behavior.
    }
    return { sections, metadata };
  }

  /**
   * Stream one section per PDF page. Metadata is emitted first so callers
   * that only need core props (title, page count) can consume it early.
   * Per-page failures are yielded as recoverable `error` events so a
   * corrupt page doesn't nuke the rest of the document.
   */
  async *parseStream(file: Buffer, ctx: ParserContext): AsyncIterable<ParserStreamEvent> {
    const pdf = await getDocumentProxy(new Uint8Array(file));
    const meta = await getMeta(pdf).catch(() => undefined);
    const totalPages = pdf.numPages;

    const info = (meta?.info ?? {}) as Record<string, unknown>;
    yield {
      type: 'metadata',
      metadata: {
        pageCount: totalPages,
        title: nonEmpty(info.Title),
        author: nonEmpty(info.Author),
        subject: nonEmpty(info.Subject),
        keywords: splitKeywords(typeof info.Keywords === 'string' ? info.Keywords : undefined),
        createdAt: toDate(info.CreationDate),
        modifiedAt: toDate(info.ModDate),
      },
    };

    for (let n = 1; n <= totalPages; n++) {
      try {
        const page = await pdf.getPage(n);
        const content = await page.getTextContent();
        const paragraphs = layoutPage(content.items);
        const blocks = paragraphs.map<Block>((text) => ctx.block.paragraph(text, { page: n }));
        yield {
          type: 'section',
          section: makeSection('page', blocks, { index: n, label: `Page ${n}` }),
        };
      } catch (err) {
        yield {
          type: 'error',
          page: n,
          error: err instanceof Error ? err : new Error(String(err)),
          recoverable: true,
        };
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Reading-order reconstruction
// ---------------------------------------------------------------------------

interface Item {
  str: string;
  x: number;
  y: number;
  w: number;
  h: number;
  hasEOL: boolean;
}

/**
 * Turn a raw list of PDF text items into paragraph strings in reading order.
 *
 * Algorithm:
 *   1. Normalize items — drop empties, extract (x, y, w, h).
 *   2. Detect columns by clustering item left-x values. Fall back to a
 *      single column when the distribution is unimodal.
 *   3. Within each column, sort top-to-bottom then left-to-right and group
 *      items into lines by y-proximity.
 *   4. Emit paragraphs by splitting on large vertical gaps between lines.
 */
function layoutPage(rawItems: unknown[]): string[] {
  const items: Item[] = [];
  for (const raw of rawItems) {
    const it = raw as {
      str?: string;
      transform?: number[];
      width?: number;
      height?: number;
      hasEOL?: boolean;
    };
    if (typeof it.str !== 'string' || !it.transform) continue;
    if (!it.str.length) continue;
    items.push({
      str: it.str,
      x: it.transform[4] ?? 0,
      y: it.transform[5] ?? 0,
      w: it.width ?? 0,
      h: it.height ?? Math.abs(it.transform[3] ?? 10),
      hasEOL: Boolean(it.hasEOL),
    });
  }
  if (items.length === 0) return [];

  const columns = splitIntoColumns(items);
  const paragraphs: string[] = [];
  for (const column of columns) {
    for (const paragraph of columnToParagraphs(column)) {
      paragraphs.push(paragraph);
    }
  }
  return paragraphs;
}

/**
 * Split items into left-to-right columns. Uses a simple gap heuristic on
 * the sorted list of left-x values: if the largest gap between adjacent
 * left-x values is more than ~15% of the page width AND wider than the
 * typical column padding, split there.
 *
 * Handles the common 1- and 2-column layouts. 3+ columns fall through to a
 * single-column read, which is still safer than random order.
 */
function splitIntoColumns(items: Item[]): Item[][] {
  if (items.length < 20) return [items];

  const minX = Math.min(...items.map((i) => i.x));
  const maxX = Math.max(...items.map((i) => i.x + i.w));
  const pageWidth = maxX - minX;
  if (pageWidth <= 0) return [items];

  // Look at the distribution of left-x values.
  const lefts = items.map((i) => i.x).sort((a, b) => a - b);
  let bestGap = 0;
  let bestSplit = 0;
  for (let i = 1; i < lefts.length; i++) {
    const gap = lefts[i] - lefts[i - 1];
    if (gap > bestGap) {
      bestGap = gap;
      bestSplit = (lefts[i] + lefts[i - 1]) / 2;
    }
  }

  // Require the gap to be at least 15% of page width — big enough to be a
  // real column gutter, not just paragraph indentation.
  if (bestGap < pageWidth * 0.15) return [items];

  const left: Item[] = [];
  const right: Item[] = [];
  for (const it of items) {
    (it.x < bestSplit ? left : right).push(it);
  }
  // Sanity: both columns need a meaningful share of content.
  if (left.length < items.length * 0.15 || right.length < items.length * 0.15) return [items];
  return [left, right];
}

/**
 * Convert one column's items into a list of paragraph strings by grouping
 * items into lines and splitting on vertical gaps.
 */
function columnToParagraphs(items: Item[]): string[] {
  if (items.length === 0) return [];

  // Sort top-to-bottom (PDF y grows upward), then left-to-right.
  const sorted = [...items].sort((a, b) => b.y - a.y || a.x - b.x);

  // Median height gives us a stable unit for line/paragraph gap thresholds.
  const heights = sorted.map((i) => i.h).sort((a, b) => a - b);
  const medianH = heights[Math.floor(heights.length / 2)] || 10;

  interface Line {
    y: number;
    items: Item[];
  }
  const lines: Line[] = [];
  for (const it of sorted) {
    const last = lines[lines.length - 1];
    if (last && Math.abs(last.y - it.y) <= medianH * 0.5) {
      last.items.push(it);
      // Keep the line y as the running mean-ish anchor.
      last.y = (last.y + it.y) / 2;
    } else {
      lines.push({ y: it.y, items: [it] });
    }
  }

  const lineTexts: { text: string; y: number }[] = [];
  for (const line of lines) {
    line.items.sort((a, b) => a.x - b.x);
    let text = '';
    let prev: Item | undefined;
    for (const it of line.items) {
      if (prev) {
        const gap = it.x - (prev.x + prev.w);
        const needsSpace =
          gap > medianH * 0.2 && !prev.str.endsWith(' ') && !it.str.startsWith(' ');
        if (needsSpace) text += ' ';
      }
      text += it.str;
      prev = it;
    }
    const trimmed = text.replace(/\s+/g, ' ').trim();
    if (trimmed) lineTexts.push({ text: trimmed, y: line.y });
  }

  // Split lines into paragraphs on large vertical gaps.
  const paragraphs: string[] = [];
  let buf: string[] = [];
  let prevY: number | undefined;
  for (const line of lineTexts) {
    if (prevY !== undefined && prevY - line.y > medianH * 1.6) {
      if (buf.length) paragraphs.push(joinLines(buf));
      buf = [];
    }
    buf.push(line.text);
    prevY = line.y;
  }
  if (buf.length) paragraphs.push(joinLines(buf));
  return paragraphs;
}

/** Join wrapped lines into a single paragraph, un-hyphenating soft breaks. */
function joinLines(lines: string[]): string {
  let out = '';
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (i === 0) {
      out = line;
      continue;
    }
    // "hyphen-\nnated" → "hyphenated"
    if (/[a-z]-$/.test(out)) {
      out = out.replace(/-$/, '') + line;
    } else {
      out += ' ' + line;
    }
  }
  return out.replace(/\s+/g, ' ').trim();
}

function nonEmpty(v: unknown): string | undefined {
  return typeof v === 'string' && v.trim() ? v.trim() : undefined;
}

function toDate(v: unknown): Date | undefined {
  if (v instanceof Date) return v;
  if (typeof v !== 'string') return undefined;
  const m = v.match(/^D?:?(\d{4})(\d{2})?(\d{2})?(\d{2})?(\d{2})?(\d{2})?/);
  if (!m) {
    const d = new Date(v);
    return isNaN(d.getTime()) ? undefined : d;
  }
  const [, y, mo = '01', d = '01', h = '00', mi = '00', s = '00'] = m;
  const date = new Date(Date.UTC(+y, +mo - 1, +d, +h, +mi, +s));
  return isNaN(date.getTime()) ? undefined : date;
}
