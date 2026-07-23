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
import type {
  ExtractMetadata,
  ExtractOptions,
  ExtractResult,
  FileParser,
  ParserContext,
  Section,
} from '../types';
import { UnsupportedFileTypeError } from '../types';
import { combineSignals, isValidUrl, readFileUrl, sniffZipMime, throwIfAborted } from '../util';
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
 *   concurrency: 4, // optional cap for the fanout from container parsers
 *   async parse(buffer, ctx) {
 *     const caption = await myVisionLlm(buffer);
 *     return { sections: [{ kind: 'body', blocks: [ctx.block.paragraph(caption)] }] };
 *   },
 * });
 * ```
 *
 * Parsers can declare a `concurrency` cap on themselves — the extractor
 * will never invoke a given parser more times in parallel than it
 * allows. That way each parser owns its own rate limit; the extractor
 * itself is configuration-free.
 */
export class AnyExtractor {
  private readonly parsers = new Map<string, FileParser>();
  private readonly semaphores = new WeakMap<FileParser, ParserSemaphore>();

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
   * Pass `options.signal` to cancel a running extraction, or
   * `options.timeoutMs` for a hard wall-clock deadline; both work
   * together. Cancellation propagates to URL fetches, file reads, and
   * every parser step, so a hung network or oversized document can
   * always be aborted.
   *
   * @throws {UnsupportedFileTypeError} if no parser matches the file's MIME.
   * @throws {DOMException} `AbortError` when cancelled, `TimeoutError` when `timeoutMs` elapses.
   */
  async extract(input: string | Buffer, options: ExtractOptions = {}): Promise<ExtractResult> {
    const { signal, dispose } = combineSignals(options.signal, options.timeoutMs);
    try {
      throwIfAborted(signal);
      const { buffer, source } = await toBuffer(input, signal);
      throwIfAborted(signal);
      if (!buffer || buffer.length === 0) {
        throw new Error('any-extractor: input is empty');
      }

      const detected = detectMime(
        buffer.buffer.slice(
          buffer.byteOffset,
          buffer.byteOffset + buffer.byteLength,
        ) as ArrayBuffer,
      );
      let mime = detected?.mime ?? 'text/plain';

      // Streaming-ZIP OOXML/ODF documents (e.g. modern Excel exports) fool
      // the byte-signature sniffer into reporting `application/zip`. Peek
      // at the archive's entries to recover the real document MIME.
      if (mime === 'application/zip') {
        const sniffed = await sniffZipMime(buffer);
        throwIfAborted(signal);
        if (sniffed) mime = sniffed;
      }

      const parser = this.parsers.get(mime);
      if (!parser) throw new UnsupportedFileTypeError(mime);

      const context: ParserContext = {
        block: createBlockFactory(),
        parseImage: (bytes, imgMime) => this.parseImage(bytes, imgMime),
      };
      const { sections: rawSections, metadata: parserMeta } = await parser.parse(buffer, context);
      throwIfAborted(signal);

      const sections: Section[] = rawSections.filter((s) => s.blocks.length > 0);

      const metadata: ExtractMetadata = { mime, ...(parserMeta ?? {}) };
      if (source) metadata.source = source;

      return buildResult(sections, metadata);
    } finally {
      dispose();
    }
  }

  /**
   * Run a registered image parser and flatten its output into a single
   * text string. Returns `undefined` if no parser is registered for
   * `mime` or the parser produced no text. Errors from user parsers are
   * swallowed so one bad image never breaks a document.
   *
   * If the target parser declares `concurrency`, concurrent invocations
   * are queued so the parser is never called more than that many times
   * in parallel — useful for capping fanout to rate-limited vision LLM
   * or OCR services.
   */
  private async parseImage(bytes: Buffer, mime: string): Promise<string | undefined> {
    const parser = this.parsers.get(mime);
    if (!parser) return undefined;
    const release = await this.acquireSlot(parser);
    try {
      return await this.runImageParser(parser, bytes);
    } finally {
      release();
    }
  }

  private async runImageParser(parser: FileParser, bytes: Buffer): Promise<string | undefined> {
    try {
      const subContext: ParserContext = {
        block: createBlockFactory(),
        // Nested image parsing is not supported — an image parser can't
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

  /**
   * Acquire a concurrency slot for `parser`. Returns a release function
   * that MUST be called (in a `finally`). If the parser doesn't declare
   * `concurrency`, or declares an unbounded value, the returned release
   * is a no-op and no gating is performed.
   */
  private acquireSlot(parser: FileParser): Promise<() => void> {
    const limit = normalizeConcurrency(parser.concurrency);
    if (limit === Infinity) return Promise.resolve(noop);

    let sem = this.semaphores.get(parser);
    if (!sem) {
      sem = { active: 0, queue: [] };
      this.semaphores.set(parser, sem);
    }
    const semaphore = sem;

    const release = (): void => {
      semaphore.active--;
      const next = semaphore.queue.shift();
      if (next) next();
    };

    if (semaphore.active < limit) {
      semaphore.active++;
      return Promise.resolve(release);
    }
    return new Promise<() => void>((resolve) => {
      semaphore.queue.push(() => {
        semaphore.active++;
        resolve(release);
      });
    });
  }
}

/** Per-parser gate used by {@link AnyExtractor.acquireSlot}. */
interface ParserSemaphore {
  active: number;
  queue: Array<() => void>;
}

function noop(): void {}

async function toBuffer(
  input: string | Buffer,
  signal?: AbortSignal,
): Promise<{ buffer: Buffer; source?: string }> {
  if (Buffer.isBuffer(input)) return { buffer: input, source: 'buffer' };
  if (typeof input !== 'string') {
    throw new TypeError('any-extractor: input must be a file path, URL, or Buffer');
  }
  if (isValidUrl(input)) return { buffer: await readFileUrl(input, signal), source: input };
  return { buffer: await fs.readFile(input, { signal }), source: input };
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

/**
 * Normalize a parser-declared concurrency to a positive integer, or
 * `Infinity` meaning "unbounded" (no gating). `undefined`, `0`,
 * negatives, and non-finite values all map to unbounded.
 */
function normalizeConcurrency(value: number | undefined): number {
  if (value === undefined) return Infinity;
  if (!Number.isFinite(value)) return Infinity;
  if (value <= 0) return Infinity;
  return Math.floor(value);
}
