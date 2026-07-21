import { AnyExtractor } from './extractors/any-extractor';
import {
  ExcelParser,
  OpenOfficeParser,
  PDFParser,
  PowerPointParser,
  SimpleParser,
  WordParser,
} from './file-parser';
import type { ExtractResult } from './types';

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
export type {
  Block,
  BlockBase,
  BlockFactory,
  BlockKind,
  BlockPosition,
  CodeBlock,
  DividerBlock,
  ExtractMetadata,
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
  QuoteBlock,
  Section,
  SectionKind,
  SectionNode,
  TableBlock,
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
 */
export function extract(input: string | Buffer): Promise<ExtractResult> {
  return defaultExtractor().extract(input);
}

let cached: AnyExtractor | undefined;
function defaultExtractor(): AnyExtractor {
  if (!cached) cached = createExtractor();
  return cached;
}
