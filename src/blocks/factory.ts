import { createHash } from 'crypto';
import type { BlockFactory, BlockPos, Heading, Image, List, Paragraph, Table } from '../types';

/** Short, stable id derived from the block's semantic content. */
function blockId(seed: string): string {
  return createHash('sha1').update(seed).digest('hex').slice(0, 12);
}

/** Copy only the fields that carry meaningful values. */
function withPos<T extends object>(base: T, pos?: BlockPos): T {
  if (!pos) return base;
  const out = base as T & BlockPos;
  if (typeof pos.page === 'number') out.page = pos.page;
  if (pos.sectionPath && pos.sectionPath.length) out.sectionPath = [...pos.sectionPath];
  return out;
}

/**
 * Create the {@link BlockFactory} passed to every parser. The factory
 * stamps a stable content-derived id on every block and normalizes
 * positional metadata.
 */
export function createBlockFactory(): BlockFactory {
  return {
    heading(level, text, pos): Heading {
      return withPos<Heading>(
        { type: 'heading', id: blockId(`h${level}:${text}`), level, text },
        pos,
      );
    },

    paragraph(text, pos): Paragraph {
      return withPos<Paragraph>({ type: 'paragraph', id: blockId(`p:${text}`), text }, pos);
    },

    list(items, opts): List {
      const ordered = opts?.ordered ?? false;
      return withPos<List>(
        {
          type: 'list',
          id: blockId(`${ordered ? 'ol' : 'ul'}:${items.join('¶')}`),
          ordered,
          items,
        },
        opts,
      );
    },

    table(rows, opts): Table {
      const headers = opts?.headers;
      const seed = [headers ? headers.join('|') : '', ...rows.map((r) => r.join('|'))].join('\n');
      const base: Table = {
        type: 'table',
        id: blockId(`t:${seed}`),
        rows,
      };
      if (headers) base.headers = headers;
      return withPos(base, opts);
    },

    image(args, pos): Image {
      const base: Image = {
        type: 'image',
        id: blockId(`img:${args.path ?? ''}:${args.bytes}`),
        mime: args.mime,
        bytes: args.bytes,
      };
      if (args.path) base.path = args.path;
      if (args.alt) base.alt = args.alt;
      if (args.text) base.text = args.text;
      return withPos(base, pos);
    },
  };
}
