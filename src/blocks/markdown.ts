import type { Block, Image, List, Section, Table } from '../types';

/** Separator inserted between top-level sections in the final markdown. */
export const SECTION_SEPARATOR = '\n\n---\n\n';

/**
 * Render an array of blocks as GitHub-flavored Markdown. Blocks are
 * separated by a single blank line. Deterministic — same input yields
 * the same output.
 */
export function renderMarkdown(blocks: Block[]): string {
  const chunks: string[] = [];
  for (const block of blocks) {
    const rendered = renderBlock(block);
    if (rendered) chunks.push(rendered);
  }
  return chunks.join('\n\n');
}

/**
 * Render a {@link Section} (or a raw block array) as GFM markdown. This
 * is the on-demand alternative to storing a rendered copy on every
 * section — call it only when you actually need the string.
 */
export function toMarkdown(input: Section | Block[]): string {
  const blocks = Array.isArray(input) ? input : input.blocks;
  return renderMarkdown(blocks);
}

function renderBlock(block: Block): string {
  switch (block.type) {
    case 'heading':
      return `${'#'.repeat(block.level)} ${block.text}`;
    case 'paragraph':
      return block.text;
    case 'list':
      return renderList(block);
    case 'table':
      return renderTable(block);
    case 'image':
      return renderImage(block);
  }
}

function renderList(block: List): string {
  return block.items
    .map((item, i) => (block.ordered ? `${i + 1}. ${item}` : `- ${item}`))
    .join('\n');
}

function renderTable(block: Table): string {
  const headers = block.headers ?? inferHeaders(block.rows);
  const width = headers.length;
  const lines: string[] = [];
  lines.push(`| ${headers.map(escapeCell).join(' | ')} |`);
  lines.push(`| ${headers.map(() => '---').join(' | ')} |`);
  for (const row of block.rows) {
    const padded = [...row];
    while (padded.length < width) padded.push('');
    lines.push(`| ${padded.slice(0, width).map(escapeCell).join(' | ')} |`);
  }
  return lines.join('\n');
}

function inferHeaders(rows: string[][]): string[] {
  const width = rows.reduce((m, r) => Math.max(m, r.length), 0);
  return Array.from({ length: width }, (_, i) => `Col ${i + 1}`);
}

function renderImage(block: Image): string {
  const alt = block.alt ?? 'image';
  const src = block.path ?? `image-${block.id}`;
  const md = `![${alt}](${src})`;
  if (!block.text) return md;
  const caption = block.text
    .split(/\r?\n/)
    .map((line) => `> ${line}`)
    .join('\n');
  return `${md}\n\n${caption}`;
}

function escapeCell(text: string): string {
  return text.replace(/\|/g, '\\|').replace(/\n/g, ' ');
}
