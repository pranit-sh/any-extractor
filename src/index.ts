import { AnyExtractor } from './extractors/any-extractor';
import {
  ExcelParser,
  OpenOfficeParser,
  PDFParser,
  PowerPointParser,
  SimpleParser,
  WordParser,
} from './file-parser';
import type { ExtractOptions, ExtractResult, ExtractorConfig } from './types';

export { AnyExtractor } from './extractors/any-extractor';
export type {
  ExtractedImage,
  ExtractMetadata,
  ExtractOptions,
  ExtractResult,
  ExtractorConfig,
  FileParser,
  ParserContext,
  ParserOutput,
  ParserResult,
  Section,
  SectionKind,
} from './types';
export { UnsupportedFileTypeError } from './types';
export {
  ExcelParser,
  OpenOfficeParser,
  PDFParser,
  PowerPointParser,
  SimpleParser,
  WordParser,
} from './file-parser';

/**
 * Build a fully-configured {@link AnyExtractor} with all built-in parsers
 * registered (Word, Excel, PowerPoint, PDF, OpenOffice, plain text/JSON).
 *
 * Prefer this over `new AnyExtractor()` unless you want an empty registry.
 */
export function createExtractor(config?: ExtractorConfig): AnyExtractor {
  const extractor = new AnyExtractor(config);
  extractor
    .addParser(new SimpleParser())
    .addParser(new PDFParser())
    .addParser(new OpenOfficeParser())
    .addParser(new WordParser())
    .addParser(new ExcelParser())
    .addParser(new PowerPointParser());
  return extractor;
}

/**
 * Extract plain text from a file path, HTTP(S) URL, or Buffer.
 *
 * ```ts
 * const text = await extractText('./resume.pdf');
 * const text = await extractText(buffer);
 * const text = await extractText('https://example.com/file.docx', {
 *   auth: { user: 'me', password: 'secret' },
 * });
 * ```
 */
export function extractText(input: string | Buffer, options?: ExtractOptions): Promise<string> {
  return defaultExtractor().extract(input, options);
}

/**
 * Extract structured text and metadata from a file path, HTTP(S) URL, or Buffer.
 *
 * Returns ordered sections (pages, slides, sheets, notes, …) plus file-level
 * metadata. Use this over {@link extractText} when you need provenance for
 * RAG, citation, or search indexing.
 *
 * ```ts
 * const { text, sections, metadata } = await extract('./deck.pptx');
 * for (const s of sections) {
 *   console.log(s.label, s.text);
 * }
 * ```
 */
export function extract(input: string | Buffer, options?: ExtractOptions): Promise<ExtractResult> {
  return defaultExtractor().extractStructured(input, options);
}

let cached: AnyExtractor | undefined;
function defaultExtractor(): AnyExtractor {
  if (!cached) cached = createExtractor();
  return cached;
}
