import { AnyExtractor } from './extractors/any-extractor';
import type { ExtractResult } from './types';

export { AnyExtractor } from './extractors/any-extractor';

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
 * Returns a flat markdown string, section-scoped markdown + blocks, and
 * lightweight metadata. Auto-detects the file's MIME type.
 *
 * This is the zero-config entry point. Instantiate {@link AnyExtractor}
 * yourself if you want to register custom parsers via `addParser()`.
 *
 * @throws {UnsupportedFileTypeError} if the file's type isn't supported.
 *
 * @example
 * ```ts
 * import { extract } from 'any-extractor';
 *
 * const { markdown, sections, metadata } = await extract('./report.pdf');
 * console.log(metadata.pageCount, markdown.length);
 * ```
 */
export function extract(input: string | Buffer): Promise<ExtractResult> {
  if (!cached) cached = new AnyExtractor();
  return cached.extract(input);
}
