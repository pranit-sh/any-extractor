import { createHash } from 'crypto';
import type {
  Block,
  BlockFactory,
  BlockPosition,
  CodeBlock,
  DividerBlock,
  HeadingBlock,
  ImageBlock,
  InlineRun,
  ListBlock,
  ListItem,
  ParagraphBlock,
  QuoteBlock,
  TableBlock,
} from '../types';

/** Short, stable id derived from the block's semantic content. */
function blockId(seed: string): string {
  return createHash('sha1').update(seed).digest('hex').slice(0, 12);
}

function normalizePos(pos?: BlockPosition): BlockPosition {
  if (!pos) return {};
  const { page, sectionPath } = pos;
  const out: BlockPosition = {};
  if (typeof page === 'number') out.page = page;
  if (sectionPath && sectionPath.length) out.sectionPath = [...sectionPath];
  return out;
}

function runsFrom(input: InlineRun[] | string): InlineRun[] {
  if (typeof input === 'string') return input ? [{ text: input }] : [];
  return input.filter((r) => r.text.length > 0);
}

function runsSeed(runs: InlineRun[]): string {
  return runs
    .map((r) =>
      [r.text, r.bold ? 'b' : '', r.italic ? 'i' : '', r.code ? 'c' : '', r.href ?? ''].join('|'),
    )
    .join('§');
}

/**
 * Create the {@link BlockFactory} passed to every parser. The factory stamps
 * a stable content-derived id and normalized position on every block.
 */
export function createBlockFactory(): BlockFactory {
  return {
    heading(level, text, pos): HeadingBlock {
      return {
        type: 'heading',
        id: blockId(`h${level}:${text}`),
        position: normalizePos(pos),
        level,
        text,
      };
    },

    paragraph(input, pos): ParagraphBlock {
      const runs = runsFrom(input);
      return {
        type: 'paragraph',
        id: blockId(`p:${runsSeed(runs)}`),
        position: normalizePos(pos),
        runs,
      };
    },

    list(items, opts): ListBlock {
      const ordered = opts?.ordered ?? false;
      const seed = items.map((i) => runsSeed(i.runs)).join('¶');
      return {
        type: 'list',
        id: blockId(`${ordered ? 'ol' : 'ul'}:${seed}`),
        position: normalizePos(opts),
        ordered,
        items: items.map<ListItem>((i) => ({
          runs: runsFrom(i.runs),
          ...(i.children && i.children.length ? { children: i.children } : {}),
        })),
      };
    },

    table(rows, opts): TableBlock {
      const headers = opts?.headers;
      const seed = [headers ? headers.join('|') : '', ...rows.map((r) => r.join('|'))].join('\n');
      return {
        type: 'table',
        id: blockId(`t:${seed}`),
        position: normalizePos(opts),
        ...(headers ? { headers } : {}),
        rows,
        ...(opts?.raw ? { raw: opts.raw } : {}),
      };
    },

    code(code, opts): CodeBlock {
      const language = opts?.language;
      return {
        type: 'code',
        id: blockId(`code:${language ?? ''}:${code}`),
        position: normalizePos(opts),
        ...(language ? { language } : {}),
        code,
      };
    },

    quote(text, pos): QuoteBlock {
      return {
        type: 'quote',
        id: blockId(`q:${text}`),
        position: normalizePos(pos),
        text,
      };
    },

    image(args, pos): ImageBlock {
      return {
        type: 'image',
        id: blockId(`img:${args.path ?? ''}:${args.bytes}`),
        position: normalizePos(pos),
        mime: args.mime,
        ...(args.path ? { path: args.path } : {}),
        bytes: args.bytes,
        ...(args.alt ? { alt: args.alt } : {}),
        ...(args.description ? { description: args.description } : {}),
      };
    },

    divider(pos): DividerBlock {
      return {
        type: 'divider',
        id: blockId(`hr:${pos?.page ?? ''}:${pos?.sectionPath?.join('>') ?? ''}`),
        position: normalizePos(pos),
      };
    },
  };
}

// Re-export the union to keep imports terse from parsers.
export type { Block };
