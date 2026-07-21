import type { Element } from '@xmldom/xmldom';
import { makeSection } from '../blocks';
import type {
  Block,
  BlockPos,
  ExtractedFile,
  FileParser,
  ParserContext,
  ParserResult,
  Section,
} from '../types';
import { extractFiles, parseXml } from '../util';
import { guessImageMime, parseCoreProperties } from './ooxml-utils';

/**
 * Parser for `.docx` (Office Open XML) files.
 *
 * Emits a single `body` section. Content is parsed into structured blocks:
 * headings (from `pStyle`), paragraphs with inline markdown (bold / italic
 * / hyperlinks baked in), lists (from `numPr` / `ListParagraph` style),
 * tables, and inline images.
 */
export class WordParser implements FileParser {
  readonly mimes = [
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  ] as const;

  async parse(file: Buffer, context: ParserContext): Promise<ParserResult> {
    const mainRegex = /word\/document\d*\.xml/;
    const mediaRegex = /^word\/media\//;
    const relsRegex = /^word\/_rels\/document\.xml\.rels$/;
    const coreRegex = /^docProps\/core\.xml$/;

    const files = await extractFiles(
      file,
      (path) =>
        mainRegex.test(path) ||
        relsRegex.test(path) ||
        coreRegex.test(path) ||
        mediaRegex.test(path),
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

    const blocks = extractBlocks(mainDoc.content.toString(), rels, media, context);

    const sections: Section[] = [];
    if (blocks.length) sections.push(makeSection('body', blocks));

    const coreFile = find(coreRegex);
    const metadata = coreFile ? parseCoreProperties(coreFile.content.toString()) : {};
    return { sections, metadata };
  }
}

// ---------------------------------------------------------------------------
// Relationships (rId → embedded target)
// ---------------------------------------------------------------------------

interface Relationships {
  media: Record<string, string>;
  hyperlinks: Record<string, string>;
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

function extractBlocks(
  xml: string,
  rels: Relationships,
  media: Record<string, ExtractedFile>,
  ctx: ParserContext,
): Block[] {
  const doc = parseXml(xml);
  const bodyEl = doc.getElementsByTagName('w:body')[0] ?? doc.documentElement;
  if (!bodyEl) return [];

  const blocks: Block[] = [];
  const headingStack: string[] = [];
  let listBuffer: { items: string[]; ordered: boolean; pos: BlockPos } | null = null;

  const flushList = (): void => {
    if (listBuffer && listBuffer.items.length) {
      blocks.push(
        ctx.block.list(listBuffer.items, { ordered: listBuffer.ordered, ...listBuffer.pos }),
      );
    }
    listBuffer = null;
  };

  const currentPos = (): BlockPos =>
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
        listBuffer.items.push(info.text);
        continue;
      }
      flushList();

      if (info.headingLevel) {
        const plainText = info.plainText;
        while (headingStack.length >= info.headingLevel) headingStack.pop();
        blocks.push(ctx.block.heading(info.headingLevel, plainText, currentPos()));
        headingStack.push(plainText);
        continue;
      }

      if (info.text.length === 0 && info.images.length === 0) continue;
      if (info.text.length) blocks.push(ctx.block.paragraph(info.text, currentPos()));

      for (const img of info.images) {
        const media0 = media[img.mediaName];
        if (!media0) continue;
        const mime = guessImageMime(media0.path);
        blocks.push(
          ctx.block.image(
            {
              mime,
              path: media0.path,
              bytes: media0.content.length,
              ...(img.alt ? { alt: img.alt } : {}),
            },
            currentPos(),
          ),
        );
      }
    } else if (el.tagName === 'w:tbl') {
      flushList();
      const rows = readTable(el);
      if (rows.length) {
        blocks.push(ctx.block.table(rows.slice(1), { headers: rows[0], ...currentPos() }));
      }
    }
  }
  flushList();
  return blocks;
}

// ---------------------------------------------------------------------------
// Paragraph reader — builds an inline markdown string
// ---------------------------------------------------------------------------

interface ParagraphInfo {
  /** Inline GFM markdown string. */
  text: string;
  /** Plain text (no formatting) — used for heading text and heading stack. */
  plainText: string;
  images: { mediaName: string; alt?: string }[];
  headingLevel?: 1 | 2 | 3 | 4 | 5 | 6;
  list?: { ordered: boolean };
}

function readParagraph(p: Element, rels: Relationships): ParagraphInfo {
  const info: ParagraphInfo = { text: '', plainText: '', images: [] };
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
      // We don't resolve numbering.xml — treat every list paragraph as
      // unordered. Cheap, predictable, good enough for LLM consumption.
      info.list = { ordered: false };
    }
  }

  const parts: { md: string; plain: string }[] = [];
  walkRuns(p, rels, parts);
  info.text = parts
    .map((p) => p.md)
    .join('')
    .trim();
  info.plainText = parts
    .map((p) => p.plain)
    .join('')
    .trim();

  // Also collect embedded images at the paragraph level.
  for (const drawing of Array.from(p.getElementsByTagName('w:drawing'))) {
    const embed = attrOfFirst(drawing, 'a:blip', 'r:embed');
    const alt =
      attrOfFirst(drawing, 'wp:docPr', 'descr') ??
      attrOfFirst(drawing, 'wp:docPr', 'title') ??
      undefined;
    if (embed && rels.media[embed]) {
      const entry: { mediaName: string; alt?: string } = { mediaName: rels.media[embed] };
      if (alt) entry.alt = alt;
      info.images.push(entry);
    }
  }

  return info;
}

function walkRuns(
  node: Element,
  rels: Relationships,
  parts: { md: string; plain: string }[],
): void {
  const children = Array.from(node.childNodes).filter((n) => n.nodeType === 1) as Element[];
  for (const el of children) {
    if (el.tagName === 'w:r') {
      const rPr = firstChild(el, 'w:rPr');
      const bold = rPr ? hasChild(rPr, 'w:b') : false;
      const italic = rPr ? hasChild(rPr, 'w:i') : false;
      let raw = '';
      for (const t of Array.from(el.getElementsByTagName('w:t'))) {
        raw += t.childNodes[0]?.nodeValue ?? '';
      }
      if (!raw) continue;
      let md = escapeInline(raw);
      if (bold) md = `**${md}**`;
      if (italic) md = `*${md}*`;
      parts.push({ md, plain: raw });
    } else if (el.tagName === 'w:hyperlink') {
      const rId = el.getAttribute('r:id');
      const href = rId ? rels.hyperlinks[rId] : undefined;
      const before = parts.length;
      walkRuns(el, rels, parts);
      if (href) {
        const inner = parts
          .slice(before)
          .map((p) => p.md)
          .join('');
        const plain = parts
          .slice(before)
          .map((p) => p.plain)
          .join('');
        parts.length = before;
        parts.push({ md: `[${inner}](${href})`, plain });
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Table reader
// ---------------------------------------------------------------------------

function readTable(tbl: Element): string[][] {
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
  return rows;
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

/** Escape the small set of inline markdown metacharacters we care about. */
function escapeInline(text: string): string {
  return text.replace(/([\\`*_[\]])/g, '\\$1');
}
