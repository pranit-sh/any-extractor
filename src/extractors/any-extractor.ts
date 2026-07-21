import { promises as fs } from 'fs';
import { parse as detectMime } from 'file-type-mime';
import { createBlockFactory, renderMarkdown, SECTION_SEPARATOR } from '../blocks';
import {
  ExcelParser,
  OpenOfficeParser,
  PDFParser,
  PowerPointParser,
  SimpleParser,
  WordParser,
} from '../file-parser';
import type { ExtractMetadata, ExtractResult, FileParser, ParserContext, Section } from '../types';
import { UnsupportedFileTypeError } from '../types';
import { isValidUrl, readFileUrl } from '../util';

/**
 * Core extractor. Holds the built-in parser registry keyed by MIME type
 * and dispatches incoming files to the matching parser.
 *
 * You almost never need this directly — call {@link extract} instead.
 * @internal
 */
export class AnyExtractor {
  private readonly parsers = new Map<string, FileParser>();

  constructor() {
    for (const parser of [
      new SimpleParser(),
      new PDFParser(),
      new OpenOfficeParser(),
      new WordParser(),
      new ExcelParser(),
      new PowerPointParser(),
    ] as FileParser[]) {
      for (const mime of parser.mimes) this.parsers.set(mime, parser);
    }
  }

  /**
   * Extract structured blocks, markdown, and metadata from a file path,
   * URL, or Buffer.
   *
   * @throws {UnsupportedFileTypeError} if no parser matches the file's MIME.
   */
  async extract(input: string | Buffer): Promise<ExtractResult> {
    const { buffer, source } = await toBuffer(input);
    if (!buffer || buffer.length === 0) {
      throw new Error('any-extractor: input is empty');
    }

    const detected = detectMime(
      buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength) as ArrayBuffer,
    );
    const mime = detected?.mime ?? 'text/plain';

    const parser = this.parsers.get(mime);
    if (!parser) throw new UnsupportedFileTypeError(mime);

    const context: ParserContext = { block: createBlockFactory() };
    const { sections: rawSections, metadata: parserMeta } = await parser.parse(buffer, context);

    const sections: Section[] = [];
    for (const section of rawSections) {
      if (section.blocks.length === 0) continue;
      sections.push({ ...section, markdown: renderMarkdown(section.blocks) });
    }

    const markdown = sections
      .map((s) => s.markdown)
      .filter(Boolean)
      .join(SECTION_SEPARATOR);

    const metadata: ExtractMetadata = { mime, ...(parserMeta ?? {}) };
    if (source) metadata.source = source;

    return { markdown, sections, metadata };
  }
}

async function toBuffer(input: string | Buffer): Promise<{ buffer: Buffer; source?: string }> {
  if (Buffer.isBuffer(input)) return { buffer: input, source: 'buffer' };
  if (typeof input !== 'string') {
    throw new TypeError('any-extractor: input must be a file path, URL, or Buffer');
  }
  if (isValidUrl(input)) return { buffer: await readFileUrl(input), source: input };
  return { buffer: await fs.readFile(input), source: input };
}
