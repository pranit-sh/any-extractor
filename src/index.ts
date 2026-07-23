import { AnyExtractor } from './extractors/any-extractor';
import type { ExtractOptions, ExtractResult } from './types';

export { AnyExtractor } from './extractors/any-extractor';
export { renderMarkdown, renderText, toMarkdown, toText } from './blocks';

export type {
  Block,
  BlockBase,
  BlockFactory,
  BlockKind,
  BlockPos,
  ExtractMetadata,
  ExtractOptions,
  ExtractResult,
  FileParser,
  Heading,
  Image,
  List,
  Paragraph,
  ParserContext,
  ParserResult,
  Section,
  SectionKind,
  Table,
} from './types';

export { UnsupportedFileTypeError } from './types';

let cached: AnyExtractor | undefined;

/**
 * Extract structured content from a file path, URL, or Buffer.
 *
 * Returns typed sections of blocks, lightweight metadata, plus lazily-
 * rendered `markdown` (GFM) and `text` (plain reading-order) views.
 * Auto-detects the file's MIME type.
 *
 * `sections` is the single source of truth; `result.markdown` and
 * `result.text` are rendered on demand from those blocks (each cached
 * after first access), so the result stays compact in memory and when
 * serialized.
 *
 * This is the zero-config entry point. Instantiate {@link AnyExtractor}
 * yourself if you want to register custom parsers via `addParser()`.
 *
 * Pass `options.signal` to cancel a running extraction, or
 * `options.timeoutMs` for a hard deadline. Both may be combined; the
 * first to trigger wins.
 *
 * @throws {UnsupportedFileTypeError} if the file's type isn't supported.
 * @throws {DOMException} `AbortError` on cancel, `TimeoutError` on timeout.
 *
 * @example
 * ```ts
 * import { extract, toMarkdown, toText } from 'any-extractor';
 *
 * const { markdown, text, sections, metadata } = await extract('./report.pdf');
 * console.log(metadata.pageCount, markdown.length, text.length);
 *
 * // Per-section rendering, on demand:
 * for (const s of sections) console.log(toMarkdown(s), toText(s));
 *
 * // Cancellation and timeout:
 * const ac = new AbortController();
 * setTimeout(() => ac.abort(), 5_000);
 * await extract('https://example.com/big.pdf', { signal: ac.signal, timeoutMs: 10_000 });
 * ```
 */
export function extract(input: string | Buffer, options?: ExtractOptions): Promise<ExtractResult> {
  if (!cached) cached = new AnyExtractor();
  return cached.extract(input, options);
}
