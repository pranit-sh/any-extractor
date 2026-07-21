/**
 * Public type surface for `any-extractor`. Small, opinionated, and stable.
 *
 * The extractor turns any supported document into:
 * - a single GFM markdown string (`markdown`),
 * - ordered {@link Section}s (pages / sheets / slides / body), and
 * - typed {@link Block}s inside each section, with page/sectionPath
 *   provenance so agents can cite and filter.
 */

// ---------------------------------------------------------------------------
// Result shape
// ---------------------------------------------------------------------------

/**
 * The result of an extraction. Ordered sections rendered as markdown, plus
 * file-level metadata.
 */
export interface ExtractResult {
  /** Full document rendered as GFM markdown. */
  markdown: string;
  /** Ordered, format-agnostic sections with structured blocks. */
  sections: Section[];
  /** File-level metadata. Unknown fields are omitted. */
  metadata: ExtractMetadata;
}

/**
 * A logical container inside a document (page, slide, sheet, body).
 * Every section carries an ordered list of structured blocks plus a
 * pre-rendered markdown view.
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
  /** GFM markdown rendering of `blocks`. */
  markdown: string;
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

/** An embedded image. Metadata only — bytes are not carried. */
export interface Image extends BlockBase {
  type: 'image';
  mime: string;
  /** Path inside the container, e.g. `word/media/image1.png`. */
  path?: string;
  bytes: number;
  /** Alt text, from the document if available. */
  alt?: string;
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
// Internals — used across parsers but not exported from the package entry
// ---------------------------------------------------------------------------

/** @internal Ergonomic constructors for blocks. Used by parsers. */
export interface BlockFactory {
  heading(level: Heading['level'], text: string, pos?: BlockPos): Heading;
  paragraph(text: string, pos?: BlockPos): Paragraph;
  list(items: string[], opts?: { ordered?: boolean } & BlockPos): List;
  table(rows: string[][], opts?: { headers?: string[] } & BlockPos): Table;
  image(args: { mime: string; path?: string; bytes: number; alt?: string }, pos?: BlockPos): Image;
}

/** @internal Positional metadata a parser attaches when creating a block. */
export interface BlockPos {
  page?: number;
  sectionPath?: string[];
}

/** @internal A parser for one or more MIME types. */
export interface FileParser {
  readonly mimes: readonly string[];
  parse(file: Buffer, context: ParserContext): Promise<ParserResult>;
}

/** @internal Structured output from a parser. */
export interface ParserResult {
  sections: Section[];
  metadata?: Partial<ExtractMetadata>;
}

/** @internal Context passed to every parser. */
export interface ParserContext {
  block: BlockFactory;
}

/** @internal An entry pulled out of a zip container. */
export interface ExtractedFile {
  path: string;
  content: Buffer;
}
