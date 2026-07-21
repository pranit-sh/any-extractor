import { makeSection } from '../blocks';
import type { Block, FileParser, ParserContext, ParserResult, Section } from '../types';

/**
 * Parser for text-based formats: plain text, markdown, HTML, CSV, and
 * JSON. Emits a single `body` section.
 *
 * - `text/plain` — paragraphs split on blank lines.
 * - `text/markdown` — headings / lists / paragraphs (lightweight parser).
 * - `text/html` — headings / paragraphs / lists (tags only, no CSS).
 * - `text/csv` — a single table.
 * - `application/json` — pretty-printed inside a fenced code block, rendered
 *   as a paragraph so the shape stays flat.
 */
export class SimpleParser implements FileParser {
  readonly mimes = [
    'text/plain',
    'text/markdown',
    'text/html',
    'text/csv',
    'application/json',
  ] as const;

  async parse(file: Buffer, ctx: ParserContext): Promise<ParserResult> {
    const raw = file.toString('utf-8');
    if (!raw.trim()) return { sections: [] };

    const kind = detectFromContent(raw);
    const blocks =
      kind === 'json'
        ? parseJson(raw, ctx)
        : kind === 'html'
          ? parseHtml(raw, ctx)
          : kind === 'markdown'
            ? parseMarkdown(raw, ctx)
            : kind === 'csv'
              ? parseCsv(raw, ctx)
              : parsePlainText(raw, ctx);

    const section: Section = makeSection('body', blocks);
    return { sections: [section] };
  }
}

// ---------------------------------------------------------------------------
// Content sniffing — `file-type` groups these under text/plain so we peek.
// ---------------------------------------------------------------------------

function detectFromContent(raw: string): 'text' | 'markdown' | 'html' | 'csv' | 'json' {
  const trimmed = raw.trimStart();
  if (/^[\[{]/.test(trimmed) && looksLikeJson(trimmed)) return 'json';
  if (/^<!doctype html|^<html|^<body|^<div|^<p[ >]/i.test(trimmed)) return 'html';
  if (/^#{1,6}\s|\n#{1,6}\s|```|^-\s|^\d+\.\s/m.test(raw)) return 'markdown';
  return 'text';
}

function looksLikeJson(s: string): boolean {
  try {
    JSON.parse(s);
    return true;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Individual format parsers
// ---------------------------------------------------------------------------

function parsePlainText(raw: string, ctx: ParserContext): Block[] {
  return raw
    .split(/\n{2,}/)
    .map((chunk) => chunk.trim())
    .filter(Boolean)
    .map((chunk) => ctx.block.paragraph(chunk));
}

function parseJson(raw: string, ctx: ParserContext): Block[] {
  let pretty = raw;
  try {
    pretty = JSON.stringify(JSON.parse(raw), null, 2);
  } catch {
    /* keep original */
  }
  return [ctx.block.paragraph(`\`\`\`json\n${pretty}\n\`\`\``)];
}

function parseCsv(raw: string, ctx: ParserContext): Block[] {
  const rows = raw
    .split(/\r?\n/)
    .filter((l) => l.length > 0)
    .map(parseCsvRow);
  if (rows.length === 0) return [];
  const [headers, ...body] = rows;
  return [ctx.block.table(body, { headers })];
}

function parseCsvRow(line: string): string[] {
  const out: string[] = [];
  let cur = '';
  let quoted = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (c === '"') {
      if (quoted && line[i + 1] === '"') {
        cur += '"';
        i++;
      } else {
        quoted = !quoted;
      }
    } else if (c === ',' && !quoted) {
      out.push(cur);
      cur = '';
    } else {
      cur += c;
    }
  }
  out.push(cur);
  return out;
}

/**
 * Markdown → blocks. Deliberately small: split on blank lines, detect
 * headings, lists, code fences (as paragraphs). Everything else is a
 * paragraph.
 */
function parseMarkdown(raw: string, ctx: ParserContext): Block[] {
  const blocks: Block[] = [];
  for (const chunk of splitMarkdown(raw)) {
    const h = /^(#{1,6})\s+(.+)$/.exec(chunk);
    if (h) {
      blocks.push(ctx.block.heading(h[1].length as 1, h[2].trim()));
      continue;
    }
    if (/^```/.test(chunk)) {
      blocks.push(ctx.block.paragraph(chunk));
      continue;
    }
    if (/^(-|\*|\d+\.)\s/.test(chunk)) {
      const ordered = /^\d+\.\s/.test(chunk);
      const items = chunk
        .split(/\n(?=(?:-|\*|\d+\.)\s)/)
        .map((line) => line.replace(/^(?:-|\*|\d+\.)\s+/, '').trim())
        .filter(Boolean);
      blocks.push(ctx.block.list(items, { ordered }));
      continue;
    }
    blocks.push(ctx.block.paragraph(chunk));
  }
  return blocks;
}

function splitMarkdown(raw: string): string[] {
  const out: string[] = [];
  let buf: string[] = [];
  let inFence = false;
  for (const line of raw.split(/\r?\n/)) {
    if (/^```/.test(line)) {
      buf.push(line);
      if (inFence) {
        out.push(buf.join('\n'));
        buf = [];
      }
      inFence = !inFence;
      continue;
    }
    if (!inFence && line.trim() === '') {
      if (buf.length) out.push(buf.join('\n'));
      buf = [];
    } else {
      buf.push(line);
    }
  }
  if (buf.length) out.push(buf.join('\n'));
  return out.map((s) => s.trim()).filter(Boolean);
}

// ---------------------------------------------------------------------------
// HTML → blocks (tag-only, no CSS). Good enough for scraped content.
// ---------------------------------------------------------------------------

function parseHtml(raw: string, ctx: ParserContext): Block[] {
  const blocks: Block[] = [];
  const cleaned = raw
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, '')
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, '');

  const blockRegex = /<(h[1-6]|p|ul|ol|pre|blockquote)\b[^>]*>([\s\S]*?)<\/\1>/gi;
  let match: RegExpExecArray | null;
  while ((match = blockRegex.exec(cleaned)) !== null) {
    const tag = match[1].toLowerCase();
    const inner = match[2] ?? '';
    if (/^h[1-6]$/.test(tag)) {
      const level = Number(tag[1]) as 1 | 2 | 3 | 4 | 5 | 6;
      const text = stripTags(inner).trim();
      if (text) blocks.push(ctx.block.heading(level, text));
    } else if (tag === 'p' || tag === 'blockquote' || tag === 'pre') {
      const text = stripTags(inner).trim();
      if (text) blocks.push(ctx.block.paragraph(text));
    } else if (tag === 'ul' || tag === 'ol') {
      const items = Array.from(inner.matchAll(/<li\b[^>]*>([\s\S]*?)<\/li>/gi))
        .map((m) => stripTags(m[1]).trim())
        .filter(Boolean);
      if (items.length) blocks.push(ctx.block.list(items, { ordered: tag === 'ol' }));
    }
  }
  // Fallback: no recognizable block tags at all.
  if (blocks.length === 0) {
    const text = stripTags(cleaned).trim();
    if (text) blocks.push(ctx.block.paragraph(text));
  }
  return blocks;
}

function stripTags(s: string): string {
  return s
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, ' ');
}
