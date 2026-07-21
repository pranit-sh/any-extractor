import { AnyExtractor } from './extractors/any-extractor';
import type { ExtractResult } from './types';

export { AnyExtractor } from './extractors/any-extractor';
export { renderMarkdown, renderText, toMarkdown, toText } from './blocks';

export type {
  Block,
  BlockBase,
  BlockFactory,
  BlockKind,
  BlockPos,
  ExtractMetadata,
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
 * @throws {UnsupportedFileTypeError} if the file's type isn't supported.
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
 * ```
 */
export function extract(input: string | Buffer): Promise<ExtractResult> {
  if (!cached) cached = new AnyExtractor();
  return cached.extract(input);
}
