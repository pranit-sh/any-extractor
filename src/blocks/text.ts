import type { Block, Image, List, Section, Table } from '../types';

/** Separator between top-level sections in the plain-text render. */
export const TEXT_SECTION_SEPARATOR = '\n\n\n';

/**
 * Render an array of blocks as plain reading-order text — no markdown
 * syntax, no bullets, no pipes. Deterministic; the same input always
 * yields the same output.
 *
 * Rules:
 * - `heading` → text on its own line.
 * - `paragraph` → text with inline markdown (**bold**, *italic*, `code`,
 *   `[label](url)`) stripped down to its visible characters.
 * - `list` → one item per line, bullets removed, inline markdown stripped.
 * - `table` → optional header row plus body rows, cells joined by tab;
 *   newlines inside cells collapsed to spaces so each row stays on one line.
 * - `image` → the parser-supplied `text` if present, else `alt`; empty
 *   images produce no output.
 *
 * Blocks are separated by a single blank line.
 */
export function renderText(blocks: Block[]): string {
  const chunks: string[] = [];
  for (const block of blocks) {
    const rendered = renderBlockAsText(block);
    if (rendered) chunks.push(rendered);
  }
  return chunks.join('\n\n');
}

/**
 * Render a {@link Section} (or a raw block array) as plain text. The
 * on-demand alternative to storing a rendered copy on every section.
 */
export function toText(input: Section | Block[]): string {
  const blocks = Array.isArray(input) ? input : input.blocks;
  return renderText(blocks);
}

function renderBlockAsText(block: Block): string {
  switch (block.type) {
    case 'heading':
      return stripInlineMarkdown(block.text);
    case 'paragraph':
      return stripInlineMarkdown(block.text);
    case 'list':
      return renderListAsText(block);
    case 'table':
      return renderTableAsText(block);
    case 'image':
      return renderImageAsText(block);
  }
}

function renderListAsText(block: List): string {
  return block.items.map((item) => stripInlineMarkdown(item)).join('\n');
}

function renderTableAsText(block: Table): string {
  const rows: string[][] = block.headers ? [block.headers, ...block.rows] : block.rows;
  return rows.map((row) => row.map(flattenCell).join('\t')).join('\n');
}

function renderImageAsText(block: Image): string {
  return (block.text ?? block.alt ?? '').trim();
}

function flattenCell(cell: string): string {
  return stripInlineMarkdown(cell).replace(/\r?\n/g, ' ');
}

// ---------------------------------------------------------------------------
// Inline markdown stripping — conservative, no third-party parser
// ---------------------------------------------------------------------------

/**
 * Strip inline GFM syntax down to the visible characters. Handles the
 * cases the built-in parsers actually emit: bold, italic, inline code,
 * links, and images. Nested emphasis (e.g. `***x***`) is handled by
 * applying the passes iteratively.
 */
function stripInlineMarkdown(input: string): string {
  if (!input) return input;
  let out = input;

  // Images first (so their alt survives when the whole link is stripped).
  // ![alt](url) → alt
  out = out.replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1');

  // Links: [label](url) → label
  out = out.replace(/\[([^\]]+)\]\([^)]*\)/g, '$1');

  // Inline code: `x` → x  (also ``x`` with double backticks).
  out = out.replace(/``([^`]+)``/g, '$1');
  out = out.replace(/`([^`]+)`/g, '$1');

  // Bold: **x** or __x__ → x. Apply twice to peel ***x*** → *x* → x.
  for (let i = 0; i < 2; i++) {
    out = out.replace(/\*\*([^*]+)\*\*/g, '$1');
    out = out.replace(/__([^_]+)__/g, '$1');
  }

  // Italic: *x* or _x_ → x. Only when the delimiter is not word-internal
  // (so `foo_bar_baz` and `2*3*4` stay intact).
  out = out.replace(/(^|[^\w*])\*([^*\n]+)\*(?!\w)/g, '$1$2');
  out = out.replace(/(^|[^\w_])_([^_\n]+)_(?!\w)/g, '$1$2');

  // Escaped punctuation: \* \_ \` \[ \] \( \) → literal.
  out = out.replace(/\\([*_`\[\]()\\])/g, '$1');

  return out;
}
