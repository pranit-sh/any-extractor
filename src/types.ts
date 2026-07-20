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
   * Extract text (and optionally structure) from the given file buffer.
   *
   * @param file    Raw file bytes.
   * @param context Extractor context (config, recursive parse helper).
   */
  parse(file: Buffer, context: ParserContext): Promise<ParserResult>;
}

/** Structured output from a {@link FileParser}. */
export interface ParserResult {
  /** Ordered chunks of text with provenance. */
  sections: Section[];
  /** Format-specific metadata (page counts, sheet names, core props, …). */
  metadata?: Partial<ExtractMetadata>;
}

/**
 * Options passed to {@link extractText} or {@link AnyExtractor.extract}.
 */
export interface ExtractOptions {
  /**
   * Authorization header value used when `input` is an HTTP(S) URL.
   * Accepts a full header string (e.g. `"Basic dXNlcjpwYXNz"`) or a
   * `{ user, password }` pair which is base64-encoded for you.
   */
  auth?: string | { user: string; password: string };
}

/**
 * Configuration for an {@link AnyExtractor} instance.
 */
export interface ExtractorConfig {
  /**
   * Optional callback invoked for every embedded image found while parsing
   * Word / Excel / PowerPoint files. Return a text description (e.g. from
   * OCR or a vision model) to attach to the {@link ExtractedImage}, or an
   * empty string to skip. If omitted, images are surfaced as
   * {@link ExtractedImage} entries without a `description`.
   */
  onImage?: (image: Buffer, mime: string) => Promise<string> | string;
}

/** Context object passed to every {@link FileParser.parse} call. */
export interface ParserContext {
  config: ExtractorConfig;
  /** Recursively extract text from an embedded buffer (used by container formats). */
  extract(buffer: Buffer): Promise<string>;
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
 * plus file-level metadata. `text` is a convenience concatenation for
 * callers that just want a blob.
 */
export interface ExtractResult {
  /** Convenience: concatenation of all section texts, joined by "\n\n". */
  text: string;
  /** Ordered, format-agnostic chunks with provenance. */
  sections: Section[];
  /** File-level metadata. Fields are best-effort — unknowns are omitted. */
  metadata: ExtractMetadata;
}

/**
 * A single chunk of extracted content. Parsers pick the closest {@link SectionKind}
 * for the content they emit.
 */
export interface Section {
  /** What kind of chunk this is. */
  kind: SectionKind;
  /** Human-readable label, e.g. "Page 3", "Slide 2", "Sheet: Q1 Sales". */
  label?: string;
  /** 1-based index within its kind (e.g. page number, slide number). */
  index?: number;
  /** The plain text of this section (already trimmed / normalized). */
  text: string;
  /** Images encountered while parsing this section. */
  images?: ExtractedImage[];
}

/** The categories of content a section can represent. */
export type SectionKind = 'body' | 'page' | 'slide' | 'notes' | 'sheet' | 'footnote' | 'endnote';

/** An image referenced from a section. */
export interface ExtractedImage {
  /** MIME of the image bytes, e.g. "image/png". */
  mime: string;
  /** Filename inside the container, e.g. "word/media/image1.png". */
  path?: string;
  /** Size in bytes. */
  bytes: number;
  /** Text returned by the `onImage` callback (OCR / vision), if any. */
  description?: string;
}

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
