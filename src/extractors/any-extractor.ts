import { parse as detectMime } from 'file-type-mime';
import type {
  ExtractMetadata,
  ExtractOptions,
  ExtractResult,
  ExtractorConfig,
  FileParser,
  ParserContext,
  ParserResult,
  Section,
} from '../types';
import { UnsupportedFileTypeError } from '../types';
import { isValidUrl, readFile, readFileUrl } from '../util';

/**
 * Core text extractor. Holds a registry of {@link FileParser}s keyed by MIME
 * type and dispatches incoming files to the matching parser.
 *
 * Most users don't need to instantiate this directly — call
 * {@link extractText} instead. Use this class when you want to register
 * custom parsers or reuse a configured instance across many calls.
 */
export class AnyExtractor {
  private readonly parsers = new Map<string, FileParser>();
  private readonly context: ParserContext;

  constructor(private readonly config: ExtractorConfig = {}) {
    this.context = {
      config: this.config,
      extract: (buffer) => this.extract(buffer),
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
   * Extract plain text from a file path, URL, or Buffer.
   *
   * @throws {UnsupportedFileTypeError} if the file's MIME type has no parser.
   */
  async extract(input: string | Buffer, options: ExtractOptions = {}): Promise<string> {
    const result = await this.extractStructured(input, options);
    return result.text;
  }

  /**
   * Extract structured text and metadata from a file path, URL, or Buffer.
   *
   * Returns ordered {@link Section}s (pages, slides, sheets, notes, …) plus
   * file-level {@link ExtractMetadata}. Use this over {@link extract} when
   * you need provenance for RAG, citation, or search indexing.
   *
   * @throws {UnsupportedFileTypeError} if the file's MIME type has no parser.
   */
  async extractStructured(
    input: string | Buffer,
    options: ExtractOptions = {},
  ): Promise<ExtractResult> {
    const { buffer, source } = await this.toBuffer(input, options);
    if (!buffer || buffer.length === 0) {
      throw new Error('any-extractor: input is empty');
    }

    const detected = detectMime(
      buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength) as ArrayBuffer,
    );

    // No magic bytes matched → treat as plain text if the bytes look textual.
    if (!detected) {
      const text = decodeTextOrThrow(buffer);
      return buildResult(text ? [{ kind: 'body', text }] : [], { mime: 'text/plain', source });
    }

    const parser = this.parsers.get(detected.mime);
    if (!parser) {
      throw new UnsupportedFileTypeError(detected.mime);
    }

    const output = await parser.parse(buffer, this.context);
    const parsed: ParserResult =
      typeof output === 'string'
        ? { sections: output ? [{ kind: 'body', text: output }] : [] }
        : output;

    return buildResult(parsed.sections, {
      mime: detected.mime,
      source,
      ...parsed.metadata,
    });
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
    return { buffer: await readFile(input), source: input };
  }
}

function buildResult(sections: Section[], metadata: ExtractMetadata): ExtractResult {
  const text = sections
    .map((s) => (s.label ? `--- ${s.label} ---\n${s.text}` : s.text))
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

/**
 * Best-effort UTF-8 decode. If the buffer contains many binary control bytes,
 * throw rather than return garbage.
 */
function decodeTextOrThrow(buffer: Buffer): string {
  // Sample the first 4KB — good enough to distinguish text from binary.
  const sample = buffer.subarray(0, Math.min(buffer.length, 4096));
  let suspicious = 0;
  for (const byte of sample) {
    // NUL and most C0 controls (except \t \n \r) indicate binary content.
    if (byte === 0 || (byte < 0x20 && byte !== 0x09 && byte !== 0x0a && byte !== 0x0d)) {
      suspicious++;
    }
  }
  if (suspicious / sample.length > 0.1) {
    throw new UnsupportedFileTypeError('application/octet-stream');
  }
  return buffer.toString('utf-8');
}
