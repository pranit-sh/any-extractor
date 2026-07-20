import { makeSection } from '../blocks';
import type { Block, FileParser, ParserContext, ParserResult, Section } from '../types';

/**
 * Parser for text-based formats: plain text, markdown, HTML, and JSON.
 *
 * - `text/plain` → paragraph blocks split on blank lines.
 * - `text/markdown` → single passthrough paragraph (the input is already markdown).
 * - `text/html` → very lightweight HTML → block conversion (headings, paragraphs,
 *   lists, code, blockquotes). No CSS, no sanitization.
 * - `application/json` → a single fenced `json` code block, pretty-printed if valid.
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

    const mime = detectFromContent(raw);
    const blocks =
      mime === 'json'
        ? parseJson(raw, ctx)
        : mime === 'html'
          ? parseHtml(raw, ctx)
          : mime === 'markdown'
            ? parseMarkdown(raw, ctx)
            : mime === 'csv'
              ? parseCsv(raw, ctx)
              : parsePlainText(raw, ctx);

    const section: Section = makeSection('body', blocks);
    return { sections: [section] };
  }
}

// ---------------------------------------------------------------------------
// Content sniffing — we might get any of these under text/plain if `file-type`
// didn't discriminate, so peek at the string.
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
// Parsers
// ---------------------------------------------------------------------------

function parsePlainText(raw: string, ctx: ParserContext): Block[] {
  return raw
    .split(/\n{2,}/)
    .map((chunk) => chunk.trim())
    .filter(Boolean)
    .map((chunk) => ctx.block.paragraph(chunk));
}

function parseJson(raw: string, ctx: ParserContext): Block[] {
  try {
    const pretty = JSON.stringify(JSON.parse(raw), null, 2);
    return [ctx.block.code(pretty, { language: 'json' })];
  } catch {
    return [ctx.block.code(raw, { language: 'json' })];
  }
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
 * Markdown → blocks. We keep this deliberately small: split on blank lines,
 * detect headings, code fences, lists. Anything else is a paragraph.
 */
function parseMarkdown(raw: string, ctx: ParserContext): Block[] {
  const blocks: Block[] = [];
  const chunks = splitMarkdown(raw);
  for (const chunk of chunks) {
    const h = /^(#{1,6})\s+(.+)$/.exec(chunk);
    if (h) {
      blocks.push(ctx.block.heading(h[1].length as 1, h[2].trim()));
      continue;
    }
    const fence = /^```(\w*)\n([\s\S]*?)\n```$/.exec(chunk);
    if (fence) {
      blocks.push(ctx.block.code(fence[2], fence[1] ? { language: fence[1] } : undefined));
      continue;
    }
    if (/^(-|\*|\d+\.)\s/.test(chunk)) {
      const ordered = /^\d+\.\s/.test(chunk);
      const items = chunk
        .split(/\n(?=(?:-|\*|\d+\.)\s)/)
        .map((line) => line.replace(/^(?:-|\*|\d+\.)\s+/, '').trim())
        .filter(Boolean)
        .map((text) => ({ runs: [{ text }] }));
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
  // Strip script/style entirely
  const cleaned = raw
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, '')
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, '');

  const blockRegex = /<(h[1-6]|p|ul|ol|pre|blockquote|hr)\b[^>]*>([\s\S]*?)<\/\1>|<hr\s*\/?\s*>/gi;
  let match: RegExpExecArray | null;
  while ((match = blockRegex.exec(cleaned)) !== null) {
    const tag = (match[1] ?? 'hr').toLowerCase();
    const inner = match[2] ?? '';
    if (/^h[1-6]$/.test(tag)) {
      const level = Number(tag[1]) as 1 | 2 | 3 | 4 | 5 | 6;
      blocks.push(ctx.block.heading(level, stripTags(inner)));
    } else if (tag === 'p') {
      const text = stripTags(inner).trim();
      if (text) blocks.push(ctx.block.paragraph(text));
    } else if (tag === 'ul' || tag === 'ol') {
      const items = Array.from(inner.matchAll(/<li\b[^>]*>([\s\S]*?)<\/li>/gi))
        .map((m) => stripTags(m[1]).trim())
        .filter(Boolean)
        .map((text) => ({ runs: [{ text }] }));
      if (items.length) blocks.push(ctx.block.list(items, { ordered: tag === 'ol' }));
    } else if (tag === 'pre') {
      const code = stripTags(inner);
      if (code) blocks.push(ctx.block.code(code));
    } else if (tag === 'blockquote') {
      const text = stripTags(inner).trim();
      if (text) blocks.push(ctx.block.quote(text));
    } else if (tag === 'hr') {
      blocks.push(ctx.block.divider());
    }
  }
  // Fallback if the doc has no recognizable block tags at all.
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
