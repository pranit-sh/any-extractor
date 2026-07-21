/**
 * Public type surface for `any-extractor`. Small, opinionated, and stable.
 *
 * The extractor turns any supported document into:
 * - a single GFM markdown string (`markdown`, rendered lazily on access),
 * - a plain-text string (`text`, also lazy) for callers that don't want
 *   markdown syntax,
 * - ordered {@link Section}s (pages / sheets / slides / body), and
 * - typed {@link Block}s inside each section, with page/sectionPath
 *   provenance so agents can cite and filter.
 *
 * `blocks` is the single source of truth; `markdown` and `text` are
 * derived from it via {@link toMarkdown} / {@link toText} (or the lazy
 * getters on the result). Nothing is duplicated in memory unless read.
 */

// ---------------------------------------------------------------------------
// Result shape
// ---------------------------------------------------------------------------

/**
 * The result of an extraction. Ordered sections of structured blocks plus
 * file-level metadata, with lazily-rendered full-document markdown and
 * plain-text views.
 */
export interface ExtractResult {
  /**
   * Full document rendered as GFM markdown. Computed on first access
   * from `sections` and cached. Free if you never touch it.
   */
  readonly markdown: string;
  /**
   * Full document as plain reading-order text — no markdown syntax, no
   * bullets, no pipes. Lazy and cached like `markdown`. Useful for
   * embeddings, search indices, TTS, and cheap token counts.
   */
  readonly text: string;
  /** Ordered, format-agnostic sections with structured blocks. */
  sections: Section[];
  /** File-level metadata. Unknown fields are omitted. */
  metadata: ExtractMetadata;
}

/**
 * A logical container inside a document (page, slide, sheet, body).
 * Holds an ordered list of structured blocks in reading order. To render
 * a section as GFM markdown, call {@link toMarkdown}.
 */
export interface Section {
  /** What kind of section this is. */
  kind: SectionKind;
  /** Human-readable label, e.g. "Page 3", "Slide 2", "Sheet: Q1 Sales". */
  label?: string;
  /** 1-based index within its kind (page / slide / sheet number). */
  index?: number;
  /** Structured content, in reading order. */
  blocks: Block[];
}

/** The categories of content a section can represent. */
export type SectionKind = 'body' | 'page' | 'slide' | 'sheet';

// ---------------------------------------------------------------------------
// Block model — 5 types, that's it
// ---------------------------------------------------------------------------

/** A structured chunk of content inside a section. */
export type Block = Heading | Paragraph | List | Table | Image;

/** The kind discriminator for {@link Block}. */
export type BlockKind = Block['type'];

/** Shared fields on every block. */
export interface BlockBase {
  /** Stable, content-derived id. Deterministic across runs. */
  id: string;
  /** 1-based page / slide number when known. */
  page?: number;
  /** Heading breadcrumb, e.g. `["Chapter 2", "1.3 Results"]`. */
  sectionPath?: string[];
}

export interface Heading extends BlockBase {
  type: 'heading';
  level: 1 | 2 | 3 | 4 | 5 | 6;
  text: string;
}

/**
 * A paragraph. `text` is inline GFM markdown — bold/italic/links are
 * baked in as markdown syntax, not exposed as separate fields.
 */
export interface Paragraph extends BlockBase {
  type: 'paragraph';
  text: string;
}

/**
 * A list. Items are inline GFM markdown strings; nested lists are not
 * modeled — real documents flatten fine at this level.
 */
export interface List extends BlockBase {
  type: 'list';
  ordered: boolean;
  items: string[];
}

/**
 * A table. Headers and body cells are plain strings (inline markdown
 * allowed). Merged cells from source documents are fanned out across every
 * covered cell so retrieval sees the value in every position.
 */
export interface Table extends BlockBase {
  type: 'table';
  /** Optional header row. */
  headers?: string[];
  /** Body rows. */
  rows: string[][];
}

/**
 * An embedded image. Metadata only — image bytes are not carried on the
 * result. If a parser is registered for the image's MIME type (see
 * {@link AnyExtractor.addParser}), the extracted text is surfaced on
 * `text` so downstream agents can consume it inline.
 */
export interface Image extends BlockBase {
  type: 'image';
  mime: string;
  /** Path inside the container, e.g. `word/media/image1.png`. */
  path?: string;
  bytes: number;
  /** Alt text, from the document if available. */
  alt?: string;
  /**
   * Text extracted from the image itself (e.g. OCR / vision LLM output),
   * populated when a user parser is registered for this image's MIME.
   */
  text?: string;
}

// ---------------------------------------------------------------------------
// Metadata
// ---------------------------------------------------------------------------

/** File-level metadata surfaced by extraction. Best-effort. */
export interface ExtractMetadata {
  /** Detected MIME type of the input. */
  mime: string;
  /** Source, if known: file path, URL, or `"buffer"`. */
  source?: string;
  /** Document title. */
  title?: string;
  /** Document author / creator. */
  author?: string;
  /** Number of pages (PDF). */
  pageCount?: number;
  /** Number of slides (PPTX / ODP). */
  slideCount?: number;
  /** Worksheet names in workbook order (XLSX / ODS). */
  sheetNames?: string[];
}

/** Thrown when no built-in parser matches the detected MIME type. */
export class UnsupportedFileTypeError extends Error {
  constructor(public readonly mime: string) {
    super(`any-extractor: unsupported file type "${mime}"`);
    this.name = 'UnsupportedFileTypeError';
  }
}

// ---------------------------------------------------------------------------
// Parser plugin surface — public so users can implement their own parsers
// ---------------------------------------------------------------------------

/**
 * A parser for one or more MIME types. Implement this to plug your own
 * extractor (e.g. a vision LLM for images) into {@link AnyExtractor} via
 * `addParser()`. User parsers override built-ins for matching MIMEs.
 */
export interface FileParser {
  /** MIME types this parser handles. */
  readonly mimes: readonly string[];
  /** Parse a file buffer into sections + metadata. */
  parse(file: Buffer, context: ParserContext): Promise<ParserResult>;
}

/** Structured output from a parser. */
export interface ParserResult {
  sections: Section[];
  metadata?: Partial<ExtractMetadata>;
}

/** Context passed to every parser. */
export interface ParserContext {
  /** Constructors for structured blocks. */
  block: BlockFactory;
  /**
   * Run a registered image parser over the given bytes and return the
   * flattened text, or `undefined` if no parser is registered for `mime`
   * or the parser produced no text. Never throws — errors from user
   * parsers are swallowed. Used by container parsers (Word / PPTX / ODT)
   * to enrich {@link Image} blocks.
   */
  parseImage(bytes: Buffer, mime: string): Promise<string | undefined>;
}

/** Ergonomic constructors for blocks. */
export interface BlockFactory {
  heading(level: Heading['level'], text: string, pos?: BlockPos): Heading;
  paragraph(text: string, pos?: BlockPos): Paragraph;
  list(items: string[], opts?: { ordered?: boolean } & BlockPos): List;
  table(rows: string[][], opts?: { headers?: string[] } & BlockPos): Table;
  image(
    args: { mime: string; path?: string; bytes: number; alt?: string; text?: string },
    pos?: BlockPos,
  ): Image;
}

/** Positional metadata a parser attaches when creating a block. */
export interface BlockPos {
  page?: number;
  sectionPath?: string[];
}

/** @internal An entry pulled out of a zip container. */
export interface ExtractedFile {
  path: string;
  content: Buffer;
}
