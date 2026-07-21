import { AnyExtractor } from './extractors/any-extractor';
import type { ExtractResult } from './types';

export type {
  Block,
  BlockBase,
  BlockKind,
  ExtractMetadata,
  ExtractResult,
  Heading,
  Image,
  List,
  Paragraph,
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
