import { AnyExtractor } from './extractors/any-extractor';
import { ExtractorConfig } from './types';
import {
  ExcelParser,
  ImageParser,
  OpenOfficeParser,
  PDFParser,
  PowerPointParser,
  SimpleParser,
  WordParser,
} from './file-parser';

/**
 * Get an extractor with parsers for various file formats.
 *
 * @param {ExtractorConfig} [config] - Optional configuration for the extractor.
 * @returns {AnyExtractor} - The configured AnyExtractor instance.
 */
export const getAnyExtractor = (config?: ExtractorConfig): AnyExtractor => {
  const anyExtractor = new AnyExtractor(config);

  // List of parsers for handling various file types
  const parsers = [
    new ExcelParser(anyExtractor),
    new ImageParser(),
    new OpenOfficeParser(),
    new PDFParser(),
    new PowerPointParser(anyExtractor),
    new SimpleParser(),
    new WordParser(anyExtractor),
  ];

  parsers.forEach((parser) => anyExtractor.addParser(parser));

  return anyExtractor;
};

export * from './types';
