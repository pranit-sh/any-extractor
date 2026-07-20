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
  return new AnyExtractor(config)
    .addParser(new SimpleParser())
    .addParser(new PDFParser())
    .addParser(new OpenOfficeParser())
    .addParser(new WordParser())
    .addParser(new ExcelParser())
    .addParser(new PowerPointParser());
}

/**
 * Extract structured text and metadata from a file path, HTTP(S) URL, or Buffer.
 *
 * Returns ordered sections (pages, slides, sheets, notes, …) plus file-level
 * metadata. `result.text` is a plain-text concatenation of all section texts.
 *
 * ```ts
 * const { text, sections, metadata } = await extract('./deck.pptx');
 * for (const s of sections) {
 *   console.log(s.label, s.text);
 * }
 * ```
 */
export function extract(input: string | Buffer, options?: ExtractOptions): Promise<ExtractResult> {
  return defaultExtractor().extract(input, options);
}

/**
 * Shortcut for `extract(input).then(r => r.text)` — returns just the plain text.
 *
 * ```ts
 * const text = await extractText('./resume.pdf');
 * ```
 */
export async function extractText(
  input: string | Buffer,
  options?: ExtractOptions,
): Promise<string> {
  const { text } = await defaultExtractor().extract(input, options);
  return text;
}

let cached: AnyExtractor | undefined;
function defaultExtractor(): AnyExtractor {
  if (!cached) cached = createExtractor();
  return cached;
}
