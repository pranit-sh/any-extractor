import { promises as fs } from 'fs';
import { parse as detectMime } from 'file-type-mime';
import { createBlockFactory, renderMarkdown, SECTION_SEPARATOR } from '../blocks';
import type {
  ExtractMetadata,
  ExtractOptions,
  ExtractResult,
  FileParser,
  ParserContext,
  Section,
} from '../types';
import { UnsupportedFileTypeError } from '../types';
import { isValidUrl, readFileUrl } from '../util';

/**
 * Core extractor. Holds a registry of {@link FileParser}s keyed by MIME
 * type and dispatches incoming files to the matching parser.
 *
 * Most users don't need to instantiate this directly — call
 * {@link extract} instead. Use this class when you want to register custom
 * parsers or reuse a configured instance.
 */
export class AnyExtractor {
  private readonly parsers = new Map<string, FileParser>();

  /** Register (or overwrite) a parser for its declared MIME types. */
  addParser(parser: FileParser): this {
    for (const mime of parser.mimes) {
      this.parsers.set(mime, parser);
    }
    return this;
  }

  /**
   * Extract structured blocks, markdown, and metadata from a file path, URL,
   * or Buffer.
   *
   * @throws {UnsupportedFileTypeError} if the file's MIME type has no parser.
   */
  async extract(input: string | Buffer, options: ExtractOptions = {}): Promise<ExtractResult> {
    const { buffer, source } = await this.toBuffer(input, options);
    if (!buffer || buffer.length === 0) {
      throw new Error('any-extractor: input is empty');
    }

    const detected = detectMime(
      buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength) as ArrayBuffer,
    );
    const mime = detected?.mime ?? 'text/plain';

    const parser = this.parsers.get(mime);
    if (!parser) {
      throw new UnsupportedFileTypeError(mime);
    }

    const mdOptions = { sectionSeparator: SECTION_SEPARATOR };
    const context: ParserContext = {
      block: createBlockFactory(),
      extract: async (buf) => (await this.extract(buf, options)).markdown,
      describe: async (buf) => {
        try {
          return (await this.extract(buf, options)).markdown;
        } catch (err) {
          if (err instanceof UnsupportedFileTypeError) return '';
          throw err;
        }
      },
    };

    const { sections, metadata } = await parser.parse(buffer, context);

    // Render markdown per section, and the whole document.
    const renderedSections: Section[] = sections
      .filter((s) => s.blocks.length > 0)
      .map((s) => ({ ...s, markdown: renderMarkdown(s.blocks) }));

    const markdown = renderedSections
      .map((s) => s.markdown)
      .filter(Boolean)
      .join(mdOptions.sectionSeparator);

    const fullMetadata: ExtractMetadata = { mime, source, ...metadata };
    return { markdown, sections: renderedSections, metadata: fullMetadata };
  }

  private async toBuffer(
    input: string | Buffer,
    options: ExtractOptions,
  ): Promise<{ buffer: Buffer; source: string }> {
    if (Buffer.isBuffer(input)) return { buffer: input, source: 'buffer' };
    if (typeof input !== 'string') {
      throw new TypeError('any-extractor: input must be a file path, URL, or Buffer');
    }
    if (isValidUrl(input)) {
      return {
        buffer: await readFileUrl(input, buildAuthHeader(options.auth)),
        source: input,
      };
    }
    return { buffer: await fs.readFile(input), source: input };
  }
}

function buildAuthHeader(auth: ExtractOptions['auth']): string | undefined {
  if (!auth) return undefined;
  if (typeof auth === 'string') return auth;
  const encoded = Buffer.from(`${auth.user}:${auth.password}`).toString('base64');
  return `Basic ${encoded}`;
}
