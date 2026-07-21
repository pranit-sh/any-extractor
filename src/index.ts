import { AnyExtractor } from './extractors/any-extractor';
import {
  ExcelParser,
  OpenOfficeParser,
  PDFParser,
  PowerPointParser,
  SimpleParser,
  WordParser,
} from './file-parser';
import type { ExtractEvent, ExtractOptions, ExtractResult } from './types';

export { AnyExtractor } from './extractors/any-extractor';
export {
  ExcelParser,
  OpenOfficeParser,
  PDFParser,
  PowerPointParser,
  SimpleParser,
  WordParser,
} from './file-parser';
export { createBlockFactory, buildTree, makeSection, renderMarkdown } from './blocks';
export { chunk } from './chunking';
export type { Chunk, ChunkOptions } from './chunking';
export type {
  Block,
  BlockBase,
  BlockFactory,
  BlockKind,
  BlockPosition,
  CodeBlock,
  DividerBlock,
  ExtractEvent,
  ExtractMetadata,
  ExtractOptions,
  ExtractResult,
  FileParser,
  HeadingBlock,
  ImageBlock,
  InlineRun,
  ListBlock,
  ListItem,
  ParagraphBlock,
  ParserContext,
  ParserResult,
  ParserStreamEvent,
  QuoteBlock,
  Section,
  SectionKind,
  SectionNode,
  TableBlock,
  TableMerge,
} from './types';
export { UnsupportedFileTypeError } from './types';

/**
 * Build a fully-configured {@link AnyExtractor} with all built-in parsers
 * registered (Word, Excel, PowerPoint, PDF, OpenOffice, text/HTML/JSON/CSV).
 *
 * Use this if you want to register custom parsers (e.g. an image captioner)
 * or hold onto a reusable instance:
 *
 * ```ts
 * const extractor = createExtractor().addParser(myImageParser);
 * const { markdown } = await extractor.extract('./deck.pptx');
 * ```
 */
export function createExtractor(): AnyExtractor {
  return new AnyExtractor()
    .addParser(new SimpleParser())
    .addParser(new PDFParser())
    .addParser(new OpenOfficeParser())
    .addParser(new WordParser())
    .addParser(new ExcelParser())
    .addParser(new PowerPointParser());
}

/**
 * Extract structured blocks, markdown, and metadata from a file path,
 * HTTP(S) URL, or Buffer.
 *
 * ```ts
 * const { markdown, sections, metadata } = await extract('./deck.pptx');
 * console.log(markdown);
 * ```
 *
 * Pass an {@link ExtractOptions.signal} to cancel mid-extraction.
 */
export function extract(input: string | Buffer, options?: ExtractOptions): Promise<ExtractResult> {
  return defaultExtractor().extract(input, options);
}

/**
 * Stream extraction events as they become available. Sections arrive in
 * reading order — perfect for agents that want to start reasoning on
 * page 1 while page 500 is still parsing.
 *
 * ```ts
 * for await (const evt of extractStream('./big.pdf', { signal })) {
 *   if (evt.type === 'section') console.log(evt.section.markdown);
 * }
 * ```
 *
 * The stream ends with a `metadata` event. Non-fatal per-section errors
 * are yielded as `error` events unless `options.onError === 'throw'`.
 */
export function extractStream(
  input: string | Buffer,
  options?: ExtractOptions,
): AsyncIterable<ExtractEvent> {
  return defaultExtractor().stream(input, options);
}

let cached: AnyExtractor | undefined;
function defaultExtractor(): AnyExtractor {
  if (!cached) cached = createExtractor();
  return cached;
}
