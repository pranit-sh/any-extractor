import { promises as fs } from 'fs';
import { parse as detectMime } from 'file-type-mime';
import {
  createBlockFactory,
  renderMarkdown,
  renderText,
  SECTION_SEPARATOR,
  TEXT_SECTION_SEPARATOR,
} from '../blocks';
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
import { isValidUrl, readFileUrl, sniffZipMime } from '../util';
/**
 * The core extractor. Holds a MIME-keyed parser registry (built-ins plus
 * whatever you register with {@link AnyExtractor.addParser}) and
 * dispatches each incoming file to the matching parser.
 *
 * For zero-config usage, prefer the top-level {@link extract} function.
 * Instantiate this class when you want to register custom parsers or hold
 * an extractor with persistent state.
 *
 * @example Register a custom image parser for `image/png` (used for
 * standalone PNG inputs *and* to enrich images embedded in Word / PPTX /
 * ODT documents).
 * ```ts
 * const extractor = new AnyExtractor();
 * extractor.addParser({
 *   mimes: ['image/png', 'image/jpeg'],
 *   async parse(buffer, ctx) {
 *     const caption = await myVisionLlm(buffer);
 *     return { sections: [{ kind: 'body', blocks: [ctx.block.paragraph(caption)] }] };
 *   },
 * });
 * ```
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
      this.register(parser);
    }
  }

  /**
   * Register a custom {@link FileParser}. Every MIME in `parser.mimes` is
   * routed to it, overriding any previously-registered parser (built-in
   * or user) for those MIMEs.
   *
   * Container parsers (Word / PPTX / ODT) automatically use registered
   * image parsers to enrich embedded {@link Image} blocks with `text`.
   *
   * @returns `this`, for chaining.
   */
  addParser(parser: FileParser): this {
    this.register(parser);
    return this;
  }

  private register(parser: FileParser): void {
    for (const mime of parser.mimes) this.parsers.set(mime, parser);
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
    let mime = detected?.mime ?? 'text/plain';

    // Streaming-ZIP OOXML/ODF documents (e.g. modern Excel exports) fool
    // the byte-signature sniffer into reporting `application/zip`. Peek
    // at the archive's entries to recover the real document MIME.
    if (mime === 'application/zip') {
      const sniffed = await sniffZipMime(buffer);
      if (sniffed) mime = sniffed;
    }

    const parser = this.parsers.get(mime);
    if (!parser) throw new UnsupportedFileTypeError(mime);

    const context: ParserContext = {
      block: createBlockFactory(),
      parseImage: (bytes, imgMime) => this.parseImage(bytes, imgMime),
    };
    const { sections: rawSections, metadata: parserMeta } = await parser.parse(buffer, context);

    const sections: Section[] = rawSections.filter((s) => s.blocks.length > 0);

    const metadata: ExtractMetadata = { mime, ...(parserMeta ?? {}) };
    if (source) metadata.source = source;

    return buildResult(sections, metadata);
  }

  /**
   * Run a registered image parser and flatten its output into a single
   * text string. Returns `undefined` if no parser is registered for
   * `mime` or the parser produced no text. Errors from user parsers are
   * swallowed so one bad image never breaks a document.
   */
  private async parseImage(bytes: Buffer, mime: string): Promise<string | undefined> {
    const parser = this.parsers.get(mime);
    if (!parser) return undefined;
    try {
      const subContext: ParserContext = {
        block: createBlockFactory(),
        // Nested image parsing is not supported \u2014 an image parser can't
        // recursively call parseImage.
        parseImage: async () => undefined,
      };
      const { sections } = await parser.parse(bytes, subContext);
      const text = sections
        .flatMap((s) => s.blocks)
        .map(flattenBlockText)
        .filter(Boolean)
        .join('\n\n')
        .trim();
      return text || undefined;
    } catch {
      return undefined;
    }
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

/**
 * Assemble an {@link ExtractResult} whose `markdown` and `text`
 * properties are rendered lazily on first access and cached thereafter.
 * Callers who never touch them pay no rendering cost, and the block
 * arrays remain the single source of truth — no duplicated section-level
 * strings.
 */
function buildResult(sections: Section[], metadata: ExtractMetadata): ExtractResult {
  let cachedMarkdown: string | undefined;
  let cachedText: string | undefined;
  const result = { sections, metadata } as ExtractResult;
  Object.defineProperty(result, 'markdown', {
    enumerable: true,
    configurable: false,
    get(): string {
      if (cachedMarkdown === undefined) {
        cachedMarkdown = sections
          .map((s) => renderMarkdown(s.blocks))
          .filter(Boolean)
          .join(SECTION_SEPARATOR);
      }
      return cachedMarkdown;
    },
  });
  Object.defineProperty(result, 'text', {
    enumerable: true,
    configurable: false,
    get(): string {
      if (cachedText === undefined) {
        cachedText = sections
          .map((s) => renderText(s.blocks))
          .filter(Boolean)
          .join(TEXT_SECTION_SEPARATOR);
      }
      return cachedText;
    },
  });
  return result;
}

/** Flatten a single block to plain-ish text for use as an image caption. */
function flattenBlockText(block: Section['blocks'][number]): string {
  switch (block.type) {
    case 'heading':
      return block.text;
    case 'paragraph':
      return block.text;
    case 'list':
      return block.items.join('\n');
    case 'table':
      return [block.headers ?? [], ...block.rows].map((r) => r.join('\t')).join('\n');
    case 'image':
      return block.text ?? block.alt ?? '';
  }
}
