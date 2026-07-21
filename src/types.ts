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

  /**
   * Optional streaming variant. Yield {@link ParserStreamEvent}s in reading
   * order — one `section` per page/slide/sheet, an optional `metadata`
   * event (at any point), and `error` events for non-fatal per-section
   * failures.
   *
   * If a parser implements this, the extractor uses it for
   * {@link ExtractOptions}-driven streaming; otherwise the extractor falls
   * back to calling {@link parse} and yielding its sections at the end.
   */
  parseStream?(file: Buffer, context: ParserContext): AsyncIterable<ParserStreamEvent>;
}

/** Structured output from a {@link FileParser}. */
export interface ParserResult {
  /** Ordered sections (pages, slides, sheets, notes, …). */
  sections: Section[];
  /** Format-specific metadata (page counts, sheet names, core props, …). */
  metadata?: Partial<ExtractMetadata>;
}

// ---------------------------------------------------------------------------
// Streaming
// ---------------------------------------------------------------------------

/** Options accepted by both `extract()` and `extractStream()`. */
export interface ExtractOptions {
  /**
   * Abort in-flight extraction. Checked at every section boundary; parsers
   * that support fine-grained abort may also honor it internally.
   */
  signal?: AbortSignal;
  /**
   * How to handle a non-fatal per-section parser error.
   *
   * - `"skip"` — yield an `error` event and keep going. Default for
   *   `extractStream()`.
   * - `"throw"` — abort the whole extraction. Default for `extract()`.
   */
  onError?: 'skip' | 'throw';
}

/** An event yielded by {@link FileParser.parseStream} to the extractor. */
export type ParserStreamEvent =
  | { type: 'section'; section: Section }
  | { type: 'error'; page?: number; error: Error; recoverable: true }
  | { type: 'metadata'; metadata: Partial<ExtractMetadata> };

/**
 * An event yielded by the streaming extractor. Sections arrive in reading
 * order as they finish parsing; a final `metadata` event closes the stream.
 */
export type ExtractEvent =
  | { type: 'section'; section: Section }
  | {
      type: 'error';
      /** 1-based page/slide/sheet number when the parser reports one. */
      page?: number;
      /** 0-based index of the section that failed within the document. */
      sectionIndex: number;
      error: Error;
      recoverable: true;
    }
  | { type: 'metadata'; metadata: ExtractMetadata };

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
 * body, notes, …). Every section carries an ordered list of structured
 * blocks, a heading-rooted tree view of those blocks, and a markdown
 * rendering.
 */
export interface Section {
  /** What kind of section this is. */
  kind: SectionKind;
  /** Human-readable label, e.g. "Page 3", "Slide 2", "Sheet: Q1 Sales". */
  label?: string;
  /** 1-based index within its kind (e.g. page number, slide number). */
  index?: number;
  /**
   * Heading breadcrumb for this section, if the section itself is nested
   * under a broader structural context (e.g. a sheet name for XLSX).
   * Empty for top-level sections like PDF pages.
   */
  sectionPath?: string[];
  /** Structured content, in reading order. */
  blocks: Block[];
  /**
   * Heading-rooted tree view of `blocks`. Non-heading blocks live under the
   * nearest preceding heading; content before any heading (or sections that
   * have no headings at all) sits under a synthetic root node.
   *
   * Same content as `blocks`, just re-shaped for programmatic traversal.
   */
  tree: SectionNode[];
  /** GFM markdown rendering of `blocks`. */
  markdown: string;
}

/**
 * A node in the heading-rooted tree produced by {@link Section.tree}.
 *
 * - Regular nodes (`level` 1–6) correspond to a heading block and hold every
 *   non-heading block that follows it until the next heading of equal or
 *   shallower level.
 * - A synthetic root node has `level: 0` and `heading: undefined`. It is
 *   only produced when a section has content before its first heading (or
 *   no headings at all), so callers never lose data.
 */
export interface SectionNode {
  /** Heading depth (1–6) or `0` for the synthetic root. */
  level: 0 | 1 | 2 | 3 | 4 | 5 | 6;
  /** The heading block that opened this node. Absent on the synthetic root. */
  heading?: HeadingBlock;
  /** Convenience alias for `heading?.text`. Absent on the synthetic root. */
  title?: string;
  /** Non-heading blocks directly under this heading, in reading order. */
  blocks: Block[];
  /** Deeper headings nested under this one. */
  children: SectionNode[];
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
  /**
   * Merged cell regions, as reported by the source document. Row/col are
   * zero-based indices into the body `rows` (headers are peeled off — the
   * header row is not addressable here). A merge with `row: -1` means the
   * merge spans headers; parsers propagate merged values across covered
   * cells so retrieval sees the intended content in every cell.
   */
  merges?: TableMerge[];
}

/** A rectangular block of merged cells in a {@link TableBlock}. */
export interface TableMerge {
  /** Zero-based row index (into body `rows`; use `-1` for the header row). */
  row: number;
  /** Zero-based column index. */
  col: number;
  /** Number of rows spanned (>= 1). */
  rowspan: number;
  /** Number of columns spanned (>= 1). */
  colspan: number;
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
    opts?: { headers?: string[]; raw?: unknown[][]; merges?: TableMerge[] } & BlockPosition,
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
