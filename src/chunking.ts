import { createHash } from 'crypto';
import { renderMarkdown } from './blocks';
import type { Block, ExtractResult, Section } from './types';

/**
 * A retrieval-ready chunk of a document. Chunks are packed sequences of
 * whole {@link Block}s — tables, code blocks, and images are never split.
 * Every chunk carries the exact source blocks it was built from, plus
 * provenance (page, section path) inherited from those blocks.
 */
export interface Chunk {
  /**
   * Deterministic id: sha1 of the constituent block ids joined by `|`,
   * truncated to 16 chars. Re-running extraction on the same file yields
   * the same ids, making upserts to a vector store idempotent.
   */
  id: string;
  /** The chunk rendered as GitHub-flavored markdown. */
  text: string;
  /** The exact blocks this chunk was built from, in document order. */
  blocks: Block[];
  /** 0-based position of this chunk in the sequence. */
  index: number;
  /** First page touched by this chunk, if any block carries a page. */
  page?: number;
  /** Heading breadcrumb inherited from the first block that carries one. */
  sectionPath?: string[];
  /** Size of `text`, measured with the configured sizer. */
  size: number;
}

/** Options for {@link chunk}. */
export interface ChunkOptions {
  /**
   * Target maximum size for a chunk, measured with `sizer`. A chunk may
   * still exceed this if a single atomic block (table, code, image) is
   * larger — atomic blocks are never split. Default: `2000`.
   */
  maxSize?: number;
  /**
   * If a chunk would end up smaller than this, it is merged forward into
   * the next chunk (if any) even when a heading boundary was preferred.
   * Prevents tiny orphan chunks. Default: `200`.
   */
  minSize?: number;
  /**
   * Measure the size of a rendered chunk. Default: character count.
   * Provide a token counter here if you need model-exact sizing.
   */
  sizer?: (text: string) => number;
  /**
   * If true, prepend the section path (e.g. `> Chapter 2 > 1.3 Results`)
   * to each chunk's `text` so the retriever sees the context. Does not
   * affect `size`, `blocks`, or `id`. Default: `true`.
   */
  includeSectionPath?: boolean;
}

const DEFAULT_MAX_SIZE = 2000;
const DEFAULT_MIN_SIZE = 200;
const defaultSizer = (s: string): number => s.length;

/**
 * Split an {@link ExtractResult} into retrieval-ready {@link Chunk}s.
 *
 * Rules:
 * - Atomic blocks (`table`, `code`, `image`) are never split. If one
 *   exceeds `maxSize`, it becomes its own oversized chunk.
 * - Heading blocks are preferred split points — a new chunk starts on
 *   every heading unless that would leave the previous chunk smaller
 *   than `minSize`.
 * - Chunks never cross a {@link Section} boundary (a PDF page's chunks
 *   won't merge with the next page's).
 */
export function chunk(result: ExtractResult, options: ChunkOptions = {}): Chunk[] {
  const maxSize = options.maxSize ?? DEFAULT_MAX_SIZE;
  const minSize = options.minSize ?? DEFAULT_MIN_SIZE;
  const sizer = options.sizer ?? defaultSizer;
  const includeSectionPath = options.includeSectionPath ?? true;

  const out: Chunk[] = [];
  for (const section of result.sections) {
    for (const group of packBlocks(section.blocks, { maxSize, minSize, sizer })) {
      const built = buildChunk(group, section, out.length, sizer, includeSectionPath);
      out.push(built);
    }
  }
  return out;
}

interface PackConfig {
  maxSize: number;
  minSize: number;
  sizer: (text: string) => number;
}

/**
 * Pack a section's blocks into groups that respect the size budget and
 * atomic-block rules. Returns arrays of blocks (never empty).
 */
function packBlocks(blocks: Block[], cfg: PackConfig): Block[][] {
  const groups: Block[][] = [];
  let current: Block[] = [];
  let currentSize = 0;

  const flush = (): void => {
    if (current.length > 0) {
      groups.push(current);
      current = [];
      currentSize = 0;
    }
  };

  for (const block of blocks) {
    const blockText = renderMarkdown([block]);
    const blockSize = cfg.sizer(blockText);

    // Heading: prefer to start a new chunk on a heading, but keep the
    // previous chunk if it's still below minSize (avoid orphans).
    if (block.type === 'heading' && current.length > 0 && currentSize >= cfg.minSize) {
      flush();
    }

    // Would this block push us over maxSize?
    if (current.length > 0 && currentSize + blockSize > cfg.maxSize) {
      flush();
    }

    current.push(block);
    currentSize += blockSize;

    // A single atomic block bigger than maxSize gets its own oversized
    // chunk — flush immediately so it doesn't drag the next block along.
    if (currentSize >= cfg.maxSize) {
      flush();
    }
  }

  flush();
  return groups;
}

function buildChunk(
  blocks: Block[],
  section: Section,
  index: number,
  sizer: (text: string) => number,
  includeSectionPath: boolean,
): Chunk {
  const body = renderMarkdown(blocks);
  const sectionPath = firstSectionPath(blocks) ?? section.sectionPath;
  const page = firstPage(blocks);

  const text =
    includeSectionPath && sectionPath && sectionPath.length > 0
      ? `> ${sectionPath.join(' > ')}\n\n${body}`
      : body;

  const id = hashIds(blocks.map((b) => b.id));

  return {
    id,
    text,
    blocks,
    index,
    ...(page !== undefined ? { page } : {}),
    ...(sectionPath && sectionPath.length > 0 ? { sectionPath } : {}),
    size: sizer(text),
  };
}

function firstPage(blocks: Block[]): number | undefined {
  for (const b of blocks) {
    if (b.position.page !== undefined) return b.position.page;
  }
  return undefined;
}

function firstSectionPath(blocks: Block[]): string[] | undefined {
  for (const b of blocks) {
    if (b.position.sectionPath && b.position.sectionPath.length > 0) {
      return b.position.sectionPath;
    }
  }
  return undefined;
}

function hashIds(ids: string[]): string {
  return createHash('sha1').update(ids.join('|')).digest('hex').slice(0, 16);
}
