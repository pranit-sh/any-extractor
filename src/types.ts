/**
 * A parser for a specific set of MIME types.
 *
 * Implement this interface to add support for new file formats via
 * {@link AnyExtractor.addParser}.
 */
export interface FileParser {
  /** MIME types this parser handles (e.g. `['application/pdf']`). */
  readonly mimes: readonly string[];

  /**
   * Extract structured content from the given file buffer.
   *
   * @param file    Raw file bytes.
   * @param context Extractor context (config, block factory, recursive parse helper).
   */
  parse(file: Buffer, context: ParserContext): Promise<ParserResult>;
}

/** Structured output from a {@link FileParser}. */
export interface ParserResult {
  /** Ordered sections (pages, slides, sheets, notes, …). */
  sections: Section[];
  /** Format-specific metadata (page counts, sheet names, core props, …). */
  metadata?: Partial<ExtractMetadata>;
}

/** Options passed to {@link extract} or {@link AnyExtractor.extract}. */
export interface ExtractOptions {
  /**
   * Authorization header value used when `input` is an HTTP(S) URL.
   * Accepts a full header string (e.g. `"Basic dXNlcjpwYXNz"`) or a
   * `{ user, password }` pair which is base64-encoded for you.
   */
  auth?: string | { user: string; password: string };
}

/** Context object passed to every {@link FileParser.parse} call. */
export interface ParserContext {
  /** Block factory — creates typed blocks with stable ids and positions. */
  block: BlockFactory;
  /**
   * Recursively extract markdown from an embedded buffer. Throws
   * {@link UnsupportedFileTypeError} if no parser is registered for the
   * detected MIME type.
   */
  extract(buffer: Buffer): Promise<string>;
  /**
   * Best-effort variant of {@link extract}. Attempts to extract markdown
   * from an embedded buffer (typically an image), returning an empty
   * string if no parser is registered for its MIME type. Useful for
   * enriching image blocks with descriptions when the user has plugged
   * in a custom vision / OCR parser.
   */
  describe(buffer: Buffer): Promise<string>;
}

/** @internal */
export interface ExtractedFile {
  path: string;
  content: Buffer;
}

// ---------------------------------------------------------------------------
// Result shape
// ---------------------------------------------------------------------------

/**
 * The result of an extraction. Contains ordered, format-agnostic sections
 * rendered as markdown, plus file-level metadata.
 */
export interface ExtractResult {
  /** Full document rendered as GFM markdown. */
  markdown: string;
  /** Ordered, format-agnostic sections with structured blocks. */
  sections: Section[];
  /** File-level metadata. Fields are best-effort — unknowns are omitted. */
  metadata: ExtractMetadata;
}

/**
 * A section is a logical container inside a document (page, slide, sheet,
 * body, notes, …). Every section carries a tree of structured blocks and a
 * markdown rendering of those blocks.
 */
export interface Section {
  /** What kind of section this is. */
  kind: SectionKind;
  /** Human-readable label, e.g. "Page 3", "Slide 2", "Sheet: Q1 Sales". */
  label?: string;
  /** 1-based index within its kind (e.g. page number, slide number). */
  index?: number;
  /** Structured content, in reading order. */
  blocks: Block[];
  /** GFM markdown rendering of `blocks`. */
  markdown: string;
}

/** The categories of content a section can represent. */
export type SectionKind = 'body' | 'page' | 'slide' | 'notes' | 'sheet' | 'footnote' | 'endnote';

// ---------------------------------------------------------------------------
// Block model
// ---------------------------------------------------------------------------

/** A structured chunk of content inside a section. */
export type Block =
  | HeadingBlock
  | ParagraphBlock
  | ListBlock
  | TableBlock
  | CodeBlock
  | QuoteBlock
  | ImageBlock
  | DividerBlock;

/** The kind discriminator for {@link Block}. */
export type BlockKind = Block['type'];

/** Shared fields on every block. */
export interface BlockBase {
  /** Stable, content-derived id. */
  id: string;
  /** Where the block came from. All fields best-effort. */
  position: BlockPosition;
}

/** Provenance for a block. */
export interface BlockPosition {
  /** 1-based page or slide number. */
  page?: number;
  /** Heading breadcrumb, e.g. `["Chapter 2", "1.3 Results"]`. */
  sectionPath?: string[];
}

export interface HeadingBlock extends BlockBase {
  type: 'heading';
  level: 1 | 2 | 3 | 4 | 5 | 6;
  text: string;
}

export interface ParagraphBlock extends BlockBase {
  type: 'paragraph';
  runs: InlineRun[];
}

/** An inline text run with optional formatting. */
export interface InlineRun {
  text: string;
  bold?: boolean;
  italic?: boolean;
  code?: boolean;
  /** If present, the run is rendered as a link. */
  href?: string;
}

export interface ListBlock extends BlockBase {
  type: 'list';
  ordered: boolean;
  items: ListItem[];
}

export interface ListItem {
  runs: InlineRun[];
  /** Nested blocks (typically sub-lists). */
  children?: Block[];
}

export interface TableBlock extends BlockBase {
  type: 'table';
  /** Optional header row. */
  headers?: string[];
  /** Body rows as stringified cells (for markdown). */
  rows: string[][];
  /** Original typed values (numbers, dates, booleans) when known. */
  raw?: unknown[][];
}

export interface CodeBlock extends BlockBase {
  type: 'code';
  /** Language hint for the fenced code block. */
  language?: string;
  code: string;
}

export interface QuoteBlock extends BlockBase {
  type: 'quote';
  text: string;
}

export interface ImageBlock extends BlockBase {
  type: 'image';
  mime: string;
  /** Path inside the container, e.g. `word/media/image1.png`. */
  path?: string;
  bytes: number;
  /** Alt text, from the document if available. */
  alt?: string;
  /** Description of the image (e.g. produced by a custom image parser). */
  description?: string;
}

export interface DividerBlock extends BlockBase {
  type: 'divider';
}

// ---------------------------------------------------------------------------
// Block factory
// ---------------------------------------------------------------------------

/**
 * Ergonomic constructors for blocks. Parsers should use these instead of
 * building block objects by hand so ids and positions stay consistent.
 */
export interface BlockFactory {
  heading(level: HeadingBlock['level'], text: string, pos?: BlockPosition): HeadingBlock;
  paragraph(runs: InlineRun[] | string, pos?: BlockPosition): ParagraphBlock;
  list(items: ListItem[], opts?: { ordered?: boolean } & BlockPosition): ListBlock;
  table(
    rows: string[][],
    opts?: { headers?: string[]; raw?: unknown[][] } & BlockPosition,
  ): TableBlock;
  code(code: string, opts?: { language?: string } & BlockPosition): CodeBlock;
  quote(text: string, pos?: BlockPosition): QuoteBlock;
  image(
    args: { mime: string; path?: string; bytes: number; alt?: string; description?: string },
    pos?: BlockPosition,
  ): ImageBlock;
  divider(pos?: BlockPosition): DividerBlock;
}

// ---------------------------------------------------------------------------
// Metadata
// ---------------------------------------------------------------------------

/** File-level metadata surfaced by extraction. */
export interface ExtractMetadata {
  /** Detected MIME type of the input. */
  mime: string;
  /** Source, if known: file path, URL, or `"buffer"`. */
  source?: string;
  /** Document title (from core properties). */
  title?: string;
  /** Document author / creator. */
  author?: string;
  /** Document subject line. */
  subject?: string;
  /** Keyword list from core properties. */
  keywords?: string[];
  /** Document language tag (e.g. `en-US`). */
  language?: string;
  /** Creation timestamp. */
  createdAt?: Date;
  /** Last-modified timestamp. */
  modifiedAt?: Date;
  /** Number of pages (PDF). */
  pageCount?: number;
  /** Number of slides (PPTX / ODP). */
  slideCount?: number;
  /** Worksheet names in workbook order (XLSX / ODS). */
  sheetNames?: string[];
}

/** Thrown when no registered parser matches the detected MIME type. */
export class UnsupportedFileTypeError extends Error {
  constructor(public readonly mime: string) {
    super(`any-extractor: no parser registered for MIME type "${mime}"`);
    this.name = 'UnsupportedFileTypeError';
  }
}
