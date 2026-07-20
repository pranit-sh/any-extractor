import type { Element } from '@xmldom/xmldom';
import { makeSection } from '../blocks';
import type {
  Block,
  BlockPosition,
  ExtractedFile,
  FileParser,
  InlineRun,
  ListItem,
  ParserContext,
  ParserResult,
  Section,
  SectionKind,
} from '../types';
import { extractFiles, parseXml } from '../util';
import { guessImageMime, parseCoreProperties } from './ooxml-utils';

/**
 * Parser for `.docx` (Office Open XML) files.
 *
 * Emits a `body` section plus optional `footnote` / `endnote` sections.
 * Content is parsed into structured blocks: headings (from `pStyle`),
 * paragraphs (with bold / italic / hyperlink runs), lists (from `numPr`),
 * tables, and inline images.
 */
export class WordParser implements FileParser {
  readonly mimes = [
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  ] as const;

  async parse(file: Buffer, context: ParserContext): Promise<ParserResult> {
    const mainRegex = /word\/document\d*\.xml/;
    const footnotesRegex = /word\/footnotes\d*\.xml/;
    const endnotesRegex = /word\/endnotes\d*\.xml/;
    const mediaRegex = /^word\/media\//;
    const relsRegex = /^word\/_rels\/document\.xml\.rels$/;
    const coreRegex = /^docProps\/core\.xml$/;

    const files = await extractFiles(
      file,
      (path) =>
        [mainRegex, footnotesRegex, endnotesRegex, relsRegex, coreRegex].some((r) =>
          r.test(path),
        ) || mediaRegex.test(path),
    );

    const find = (regex: RegExp) => files.find((f) => regex.test(f.path));
    const mainDoc = find(mainRegex);
    const relsFile = find(relsRegex);
    if (!mainDoc || !relsFile) {
      throw new Error('any-extractor: docx is missing main document or relationships file');
    }

    const media: Record<string, ExtractedFile> = {};
    for (const f of files) {
      if (mediaRegex.test(f.path)) media[f.path.split('/').pop()!] = f;
    }

    const rels = parseRelationships(relsFile.content.toString());

    const sections: Section[] = [];

    const body = await extractBlocks(mainDoc.content.toString(), rels, media, context);
    if (body.length) sections.push(makeSection('body', body));

    const footnotes = find(footnotesRegex);
    if (footnotes) {
      const blocks = await extractBlocks(footnotes.content.toString(), rels, media, context);
      if (blocks.length) {
        sections.push(makeSection('footnote' as SectionKind, blocks, { label: 'Footnotes' }));
      }
    }

    const endnotes = find(endnotesRegex);
    if (endnotes) {
      const blocks = await extractBlocks(endnotes.content.toString(), rels, media, context);
      if (blocks.length) {
        sections.push(makeSection('endnote' as SectionKind, blocks, { label: 'Endnotes' }));
      }
    }

    const coreFile = find(coreRegex);
    const metadata = coreFile ? parseCoreProperties(coreFile.content.toString()) : {};
    return { sections, metadata };
  }
}

// ---------------------------------------------------------------------------
// Relationships (rId → embedded target)
// ---------------------------------------------------------------------------

interface Relationships {
  media: Record<string, string>; // rId → media filename
  hyperlinks: Record<string, string>; // rId → URL
}

function parseRelationships(xml: string): Relationships {
  const doc = parseXml(xml);
  const media: Record<string, string> = {};
  const hyperlinks: Record<string, string> = {};
  for (const rel of Array.from(doc.getElementsByTagName('Relationship'))) {
    const id = rel.getAttribute('Id');
    const target = rel.getAttribute('Target');
    const type = rel.getAttribute('Type') ?? '';
    if (!id || !target) continue;
    if (type.endsWith('/image') || target.startsWith('media/')) {
      media[id] = target.split('/').pop()!;
    } else if (type.endsWith('/hyperlink')) {
      hyperlinks[id] = target;
    }
  }
  return { media, hyperlinks };
}

// ---------------------------------------------------------------------------
// Body → blocks
// ---------------------------------------------------------------------------

async function extractBlocks(
  xml: string,
  rels: Relationships,
  media: Record<string, ExtractedFile>,
  ctx: ParserContext,
): Promise<Block[]> {
  const doc = parseXml(xml);
  const bodyEl = doc.getElementsByTagName('w:body')[0] ?? doc.documentElement;
  if (!bodyEl) return [];

  const blocks: Block[] = [];
  const headingStack: string[] = [];
  let listBuffer: { items: ListItem[]; ordered: boolean; pos: BlockPosition } | null = null;

  const flushList = () => {
    if (listBuffer && listBuffer.items.length) {
      blocks.push(
        ctx.block.list(listBuffer.items, { ordered: listBuffer.ordered, ...listBuffer.pos }),
      );
    }
    listBuffer = null;
  };

  const currentPos = (): BlockPosition =>
    headingStack.length ? { sectionPath: [...headingStack] } : {};

  const children = Array.from(bodyEl.childNodes).filter((n) => n.nodeType === 1) as Element[];

  for (const el of children) {
    if (el.tagName === 'w:p') {
      const info = readParagraph(el, rels);
      if (info.list) {
        if (!listBuffer || listBuffer.ordered !== info.list.ordered) {
          flushList();
          listBuffer = { items: [], ordered: info.list.ordered, pos: currentPos() };
        }
        listBuffer.items.push({ runs: info.runs });
        continue;
      }
      flushList();

      if (info.headingLevel) {
        const text = runsToPlain(info.runs);
        // Maintain heading stack: pop deeper/equal, then push this one.
        while (headingStack.length >= info.headingLevel) headingStack.pop();
        blocks.push(ctx.block.heading(info.headingLevel, text, currentPos()));
        headingStack.push(text);
        continue;
      }

      if (info.runs.length === 0 && info.images.length === 0) continue;

      if (info.runs.length) {
        blocks.push(ctx.block.paragraph(info.runs, currentPos()));
      }
      for (const img of info.images) {
        const media0 = media[img.mediaName];
        if (!media0) continue;
        const mime = guessImageMime(media0.path);
        const description = (await ctx.describe(media0.content)) || undefined;
        blocks.push(
          ctx.block.image(
            { mime, path: media0.path, bytes: media0.content.length, alt: img.alt, description },
            currentPos(),
          ),
        );
      }
    } else if (el.tagName === 'w:tbl') {
      flushList();
      const table = readTable(el);
      if (table.rows.length) {
        blocks.push(
          ctx.block.table(table.rows.slice(1), {
            headers: table.rows[0],
            ...currentPos(),
          }),
        );
      }
    }
  }
  flushList();
  return blocks;
}

// ---------------------------------------------------------------------------
// Paragraph reader
// ---------------------------------------------------------------------------

interface ParagraphInfo {
  runs: InlineRun[];
  images: { mediaName: string; alt?: string }[];
  headingLevel?: 1 | 2 | 3 | 4 | 5 | 6;
  list?: { ordered: boolean };
}

function readParagraph(p: Element, rels: Relationships): ParagraphInfo {
  const info: ParagraphInfo = { runs: [], images: [] };
  const pPr = firstChild(p, 'w:pPr');
  if (pPr) {
    const style = attrOfFirst(pPr, 'w:pStyle', 'w:val');
    if (style) {
      const m = style.match(/^Heading(\d+)$/i);
      if (m) {
        const n = Math.min(6, Math.max(1, Number(m[1]))) as 1 | 2 | 3 | 4 | 5 | 6;
        info.headingLevel = n;
      }
      if (/^ListParagraph$/i.test(style) && !info.headingLevel) {
        info.list = { ordered: false };
      }
    }
    const numPr = firstChild(pPr, 'w:numPr');
    if (numPr && !info.headingLevel) {
      // We don't resolve numbering.xml here — treat every list paragraph
      // as unordered. Cheap, predictable, good enough for LLM consumption.
      info.list = { ordered: false };
    }
  }

  // Walk paragraph children in order to build runs.
  walkRuns(p, rels, info);
  // Trim empty leading/trailing runs.
  info.runs = info.runs.filter((r) => r.text.length > 0);
  return info;
}

function walkRuns(node: Element, rels: Relationships, info: ParagraphInfo): void {
  const children = Array.from(node.childNodes).filter((n) => n.nodeType === 1) as Element[];
  for (const el of children) {
    if (el.tagName === 'w:r') {
      const run = readRun(el);
      if (run) info.runs.push(run);
      // pictures embedded inside a run
      for (const drawing of Array.from(el.getElementsByTagName('w:drawing'))) {
        const embed = attrOfFirst(drawing, 'a:blip', 'r:embed');
        const alt =
          attrOfFirst(drawing, 'wp:docPr', 'descr') ??
          attrOfFirst(drawing, 'wp:docPr', 'title') ??
          undefined;
        if (embed && rels.media[embed]) {
          info.images.push({ mediaName: rels.media[embed], alt });
        }
      }
    } else if (el.tagName === 'w:hyperlink') {
      const rId = el.getAttribute('r:id');
      const href = rId ? rels.hyperlinks[rId] : undefined;
      const before = info.runs.length;
      walkRuns(el, rels, info);
      if (href) {
        for (let i = before; i < info.runs.length; i++) info.runs[i].href = href;
      }
    }
  }
}

function readRun(r: Element): InlineRun | null {
  const rPr = firstChild(r, 'w:rPr');
  const bold = rPr ? hasChild(rPr, 'w:b') : false;
  const italic = rPr ? hasChild(rPr, 'w:i') : false;
  const code =
    rPr && (attrOfFirst(rPr, 'w:rFonts', 'w:ascii') ?? '').toLowerCase().includes('mono');
  let text = '';
  for (const t of Array.from(r.getElementsByTagName('w:t'))) {
    text += t.childNodes[0]?.nodeValue ?? '';
  }
  text += '\t'.repeat(r.getElementsByTagName('w:tab').length);
  text += '\n'.repeat(r.getElementsByTagName('w:br').length);
  if (!text) return null;
  const run: InlineRun = { text };
  if (bold) run.bold = true;
  if (italic) run.italic = true;
  if (code) run.code = true;
  return run;
}

// ---------------------------------------------------------------------------
// Table reader
// ---------------------------------------------------------------------------

function readTable(tbl: Element): { rows: string[][] } {
  const rows: string[][] = [];
  for (const tr of Array.from(tbl.getElementsByTagName('w:tr'))) {
    const row: string[] = [];
    for (const tc of Array.from(tr.getElementsByTagName('w:tc'))) {
      const cellText = Array.from(tc.getElementsByTagName('w:t'))
        .map((t) => t.childNodes[0]?.nodeValue ?? '')
        .join('')
        .trim();
      row.push(cellText);
    }
    if (row.length) rows.push(row);
  }
  return { rows };
}

// ---------------------------------------------------------------------------
// tiny DOM helpers
// ---------------------------------------------------------------------------

function firstChild(el: Element, tag: string): Element | null {
  for (const c of Array.from(el.childNodes)) {
    if (c.nodeType === 1 && (c as Element).tagName === tag) return c as Element;
  }
  return null;
}
function hasChild(el: Element, tag: string): boolean {
  return firstChild(el, tag) !== null;
}
function attrOfFirst(root: Element, tag: string, attr: string): string | undefined {
  const el = root.getElementsByTagName(tag)[0];
  return el?.getAttribute(attr) ?? undefined;
}

function runsToPlain(runs: InlineRun[]): string {
  return runs.map((r) => r.text).join('');
}
