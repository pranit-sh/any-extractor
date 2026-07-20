import { promises as fs } from 'fs';
import { parse as detectMime } from 'file-type-mime';
import type {
  ExtractMetadata,
  ExtractOptions,
  ExtractResult,
  ExtractorConfig,
  FileParser,
  ParserContext,
  Section,
} from '../types';
import { UnsupportedFileTypeError } from '../types';
import { isValidUrl, readFileUrl } from '../util';

/**
 * Core text extractor. Holds a registry of {@link FileParser}s keyed by MIME
 * type and dispatches incoming files to the matching parser.
 *
 * Most users don't need to instantiate this directly — call
 * {@link extractText} or {@link extract} instead. Use this class when you
 * want to register custom parsers or reuse a configured instance.
 */
export class AnyExtractor {
  private readonly parsers = new Map<string, FileParser>();
  private readonly context: ParserContext;

  constructor(private readonly config: ExtractorConfig = {}) {
    this.context = {
      config: this.config,
      extract: async (buffer) => (await this.extract(buffer)).text,
    };
  }

  /** Register (or overwrite) a parser for its declared MIME types. */
  addParser(parser: FileParser): this {
    for (const mime of parser.mimes) {
      this.parsers.set(mime, parser);
    }
    return this;
  }

  /**
   * Extract text, structured sections, and metadata from a file path, URL,
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

    const { sections, metadata } = await parser.parse(buffer, this.context);
    return buildResult(sections, { mime, source, ...metadata });
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

function buildResult(sections: Section[], metadata: ExtractMetadata): ExtractResult {
  const text = sections
    .map((s) => s.text)
    .filter((t) => t.length > 0)
    .join('\n\n');
  return { text, sections, metadata };
}

function buildAuthHeader(auth: ExtractOptions['auth']): string | undefined {
  if (!auth) return undefined;
  if (typeof auth === 'string') return auth;
  const encoded = Buffer.from(`${auth.user}:${auth.password}`).toString('base64');
  return `Basic ${encoded}`;
}
