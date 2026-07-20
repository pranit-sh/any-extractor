import type { Element, Node } from '@xmldom/xmldom';
import { makeSection } from '../blocks';
import type {
  Block,
  BlockPosition,
  ExtractMetadata,
  FileParser,
  ListItem,
  ParserContext,
  ParserResult,
  Section,
} from '../types';
import { extractFiles, parseXml } from '../util';

/**
 * Parser for OpenDocument formats: `.odt`, `.ods`, `.odp`, `.odg`, `.odf`.
 *
 * Emits a `body` section for the main content and a separate `notes` section
 * for `.odp` speaker notes. Content is parsed into structured blocks
 * (headings, paragraphs, lists, tables). Metadata is read from `meta.xml`.
 */
export class OpenOfficeParser implements FileParser {
  readonly mimes = [
    'application/vnd.oasis.opendocument.text',
    'application/vnd.oasis.opendocument.spreadsheet',
    'application/vnd.oasis.opendocument.presentation',
    'application/vnd.oasis.opendocument.graphics',
    'application/vnd.oasis.opendocument.formula',
  ] as const;

  async parse(file: Buffer, ctx: ParserContext): Promise<ParserResult> {
    const MAIN = 'content.xml';
    const META = 'meta.xml';
    const OBJECT_CONTENT = /Object \d+\/content\.xml/;

    const files = await extractFiles(
      file,
      (path) => path === MAIN || path === META || OBJECT_CONTENT.test(path),
    );

    const contentFiles = files
      .filter((f) => f.path === MAIN || OBJECT_CONTENT.test(f.path))
      .sort((a, b) => a.path.localeCompare(b.path));

    const bodyBlocks: Block[] = [];
    const notesBlocks: Block[] = [];
    const headingStack: string[] = [];

    for (const cf of contentFiles) {
      const doc = parseXml(cf.content.toString());
      const body =
        doc.getElementsByTagName('office:body')[0] ??
        doc.getElementsByTagName('office:text')[0] ??
        doc.documentElement;
      if (!body) continue;
      walk(body as Element, {
        headingStack,
        push: bodyBlocks,
        pushNotes: notesBlocks,
        ctx,
      });
    }

    const sections: Section[] = [];
    if (bodyBlocks.length) sections.push(makeSection('body', bodyBlocks));
    if (notesBlocks.length) sections.push(makeSection('notes', notesBlocks, { label: 'Notes' }));

    const metaFile = files.find((f) => f.path === META);
    const metadata = metaFile ? parseMeta(metaFile.content.toString()) : {};
    return { sections, metadata };
  }
}

// ---------------------------------------------------------------------------
// Walker
// ---------------------------------------------------------------------------

interface Walker {
  headingStack: string[];
  push: Block[];
  pushNotes: Block[];
  ctx: ParserContext;
}

function walk(node: Element, w: Walker, insideNotes = false): void {
  for (const c of Array.from(node.childNodes)) {
    if (c.nodeType !== 1) continue;
    const el = c as Element;
    const tag = el.tagName;

    if (tag === 'presentation:notes') {
      walk(el, w, true);
      continue;
    }

    const target = insideNotes ? w.pushNotes : w.push;
    const pos: BlockPosition = w.headingStack.length ? { sectionPath: [...w.headingStack] } : {};

    if (tag === 'text:h') {
      const level = clampLevel(Number(el.getAttribute('text:outline-level') ?? '1'));
      const text = collectText(el).trim();
      while (w.headingStack.length >= level) w.headingStack.pop();
      if (text) {
        target.push(w.ctx.block.heading(level, text, pos));
        w.headingStack.push(text);
      }
    } else if (tag === 'text:p') {
      const text = collectText(el).trim();
      if (text) target.push(w.ctx.block.paragraph(text, pos));
    } else if (tag === 'text:list') {
      const items = collectListItems(el);
      if (items.length) target.push(w.ctx.block.list(items, { ordered: false, ...pos }));
    } else if (tag === 'table:table') {
      const rows = collectTable(el);
      if (rows.length) {
        target.push(w.ctx.block.table(rows.slice(1), { headers: rows[0], ...pos }));
      }
    } else {
      walk(el, w, insideNotes);
    }
  }
}

function clampLevel(n: number): 1 | 2 | 3 | 4 | 5 | 6 {
  if (!Number.isFinite(n) || n < 1) return 1;
  if (n > 6) return 6;
  return n as 1 | 2 | 3 | 4 | 5 | 6;
}

function collectText(node: Node): string {
  let out = '';
  for (const c of Array.from(node.childNodes ?? [])) {
    if (c.nodeType === 3) out += c.nodeValue ?? '';
    else if (c.nodeType === 1) out += collectText(c);
  }
  return out;
}

function collectListItems(list: Element): ListItem[] {
  const items: ListItem[] = [];
  for (const c of Array.from(list.childNodes)) {
    if (c.nodeType !== 1) continue;
    const el = c as Element;
    if (el.tagName !== 'text:list-item') continue;
    const paragraphs = Array.from(el.getElementsByTagName('text:p')).map((p) =>
      collectText(p).trim(),
    );
    const text = paragraphs.filter(Boolean).join(' ');
    if (text) items.push({ runs: [{ text }] });
  }
  return items;
}

function collectTable(tbl: Element): string[][] {
  const rows: string[][] = [];
  for (const r of Array.from(tbl.getElementsByTagName('table:table-row'))) {
    const row: string[] = [];
    for (const cell of Array.from(r.getElementsByTagName('table:table-cell'))) {
      row.push(collectText(cell).trim());
    }
    if (row.length) rows.push(row);
  }
  return rows;
}

// ---------------------------------------------------------------------------
// Metadata
// ---------------------------------------------------------------------------

function parseMeta(xml: string): Partial<ExtractMetadata> {
  const doc = parseXml(xml);
  const get = (tag: string) => {
    const el = doc.getElementsByTagName(tag)[0];
    const v = el?.childNodes[0]?.nodeValue?.trim();
    return v || undefined;
  };
  const created = get('meta:creation-date');
  const modified = get('dc:date');
  const keywords = Array.from(doc.getElementsByTagName('meta:keyword'))
    .map((n) => n.childNodes[0]?.nodeValue?.trim())
    .filter((s): s is string => Boolean(s));
  return {
    title: get('dc:title'),
    author: get('meta:initial-creator') ?? get('dc:creator'),
    subject: get('dc:subject'),
    language: get('dc:language'),
    keywords: keywords.length ? keywords : undefined,
    createdAt: created ? new Date(created) : undefined,
    modifiedAt: modified ? new Date(modified) : undefined,
  };
}
