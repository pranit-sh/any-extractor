import type { Block, ImageBlock, InlineRun, ListBlock, ListItem, TableBlock } from '../types';

/** Separator inserted between top-level sections in the final markdown. */
export const SECTION_SEPARATOR = '\n\n---\n\n';

/**
 * Render an array of blocks as GitHub-flavored Markdown. Blocks are separated
 * by a single blank line. Deterministic — the same input always yields the
 * same output.
 */
export function renderMarkdown(blocks: Block[]): string {
  const chunks: string[] = [];
  for (const block of blocks) {
    const rendered = renderBlock(block, 0);
    if (rendered) chunks.push(rendered);
  }
  return chunks.join('\n\n');
}

function renderBlock(block: Block, depth: number): string {
  switch (block.type) {
    case 'heading':
      return `${'#'.repeat(block.level)} ${escapeInline(block.text)}`;
    case 'paragraph':
      return renderRuns(block.runs);
    case 'list':
      return renderList(block, depth);
    case 'table':
      return renderTable(block);
    case 'code':
      return `\`\`\`${block.language ?? ''}\n${block.code}\n\`\`\``;
    case 'quote':
      return block.text
        .split('\n')
        .map((line) => `> ${line}`)
        .join('\n');
    case 'image':
      return renderImage(block);
    case 'divider':
      return '---';
  }
}

function renderRuns(runs: InlineRun[]): string {
  return runs.map(renderRun).join('');
}

function renderRun(run: InlineRun): string {
  let text = escapeInline(run.text);
  if (run.code) text = `\`${run.text}\``; // no escaping inside code
  if (run.bold) text = `**${text}**`;
  if (run.italic) text = `*${text}*`;
  if (run.href) text = `[${text}](${run.href})`;
  return text;
}

function renderList(block: ListBlock, depth: number): string {
  return block.items.map((item, i) => renderListItem(item, block.ordered, i + 1, depth)).join('\n');
}

function renderListItem(item: ListItem, ordered: boolean, index: number, depth: number): string {
  const indent = '  '.repeat(depth);
  const marker = ordered ? `${index}.` : '-';
  const head = `${indent}${marker} ${renderRuns(item.runs)}`;
  if (!item.children || item.children.length === 0) return head;
  const children = item.children
    .map((child) => renderBlock(child, depth + 1))
    .filter(Boolean)
    .map((c) =>
      c
        .split('\n')
        .map((line) => (line ? `${indent}  ${line}` : line))
        .join('\n'),
    )
    .join('\n');
  return `${head}\n${children}`;
}

function renderTable(block: TableBlock): string {
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

function renderImage(block: ImageBlock): string {
  const alt = block.alt ?? block.description ?? 'image';
  const src = block.path ?? `image-${block.id}`;
  return `![${escapeInline(alt)}](${src})`;
}

// ---------------------------------------------------------------------------
// Escaping — keep it minimal, LLMs cope with mild irregularities.
// ---------------------------------------------------------------------------

function escapeInline(text: string): string {
  return text.replace(/([\\`*_{}\[\]()#+!-])/g, '\\$1');
}

function escapeCell(text: string): string {
  return text.replace(/\|/g, '\\|').replace(/\n/g, ' ');
}
