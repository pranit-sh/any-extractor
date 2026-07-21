import { promises as fs } from 'fs';
import { parse as detectMime } from 'file-type-mime';
import { buildTree, createBlockFactory, renderMarkdown, SECTION_SEPARATOR } from '../blocks';
import type {
  ExtractEvent,
  ExtractMetadata,
  ExtractOptions,
  ExtractResult,
  FileParser,
  ParserContext,
  ParserStreamEvent,
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
    const sections: Section[] = [];
    let metadata: ExtractMetadata | undefined;

    for await (const evt of this.stream(input, { onError: 'throw', ...options })) {
      if (evt.type === 'section') {
        sections.push(evt.section);
      } else if (evt.type === 'metadata') {
        metadata = evt.metadata;
      }
      // 'error' events are only produced when onError is 'skip'; batch
      // callers who opt into that get an empty result for failed sections.
    }

    const markdown = sections
      .map((s) => s.markdown)
      .filter(Boolean)
      .join(SECTION_SEPARATOR);

    return {
      markdown,
      sections,
      metadata: metadata ?? { mime: 'application/octet-stream' },
    };
  }

  /**
   * Stream extraction events as they become available. Sections arrive in
   * reading order; a final `metadata` event closes the stream.
   *
   * Cancellable via `options.signal`. Non-fatal per-section errors are
   * yielded as `error` events unless `options.onError === 'throw'`.
   *
   * @throws {UnsupportedFileTypeError} if the file's MIME type has no parser.
   */
  async *stream(input: string | Buffer, options: ExtractOptions = {}): AsyncIterable<ExtractEvent> {
    const { signal, onError = 'skip' } = options;
    signal?.throwIfAborted();

    const { buffer, source } = await this.toBuffer(input);
    if (!buffer || buffer.length === 0) {
      throw new Error('any-extractor: input is empty');
    }
    signal?.throwIfAborted();

    const detected = detectMime(
      buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength) as ArrayBuffer,
    );
    const mime = detected?.mime ?? 'text/plain';

    const parser = this.parsers.get(mime);
    if (!parser) {
      throw new UnsupportedFileTypeError(mime);
    }

    const context = this.createContext();
    const accumulatedMeta: Partial<ExtractMetadata> = {};
    let sectionIndex = 0;

    const iter: AsyncIterable<ParserStreamEvent> = parser.parseStream
      ? parser.parseStream(buffer, context)
      : batchToStream(parser, buffer, context);

    for await (const evt of iter) {
      signal?.throwIfAborted();

      if (evt.type === 'section') {
        const enriched = enrichSection(evt.section);
        if (enriched.blocks.length === 0) continue;
        yield { type: 'section', section: enriched };
        sectionIndex++;
      } else if (evt.type === 'metadata') {
        Object.assign(accumulatedMeta, evt.metadata);
      } else if (evt.type === 'error') {
        if (onError === 'throw') throw evt.error;
        const errEvt: ExtractEvent = {
          type: 'error',
          sectionIndex,
          error: evt.error,
          recoverable: true,
        };
        if (evt.page !== undefined) errEvt.page = evt.page;
        yield errEvt;
      }
    }

    yield {
      type: 'metadata',
      metadata: { mime, source, ...accumulatedMeta },
    };
  }

  private createContext(): ParserContext {
    return {
      block: createBlockFactory(),
      extract: async (buf) => (await this.extract(buf)).markdown,
      describe: async (buf) => {
        try {
          return (await this.extract(buf)).markdown;
        } catch (err) {
          if (err instanceof UnsupportedFileTypeError) return '';
          throw err;
        }
      },
    };
  }

  private async toBuffer(input: string | Buffer): Promise<{ buffer: Buffer; source: string }> {
    if (Buffer.isBuffer(input)) return { buffer: input, source: 'buffer' };
    if (typeof input !== 'string') {
      throw new TypeError('any-extractor: input must be a file path, URL, or Buffer');
    }
    if (isValidUrl(input)) {
      return { buffer: await readFileUrl(input), source: input };
    }
    return { buffer: await fs.readFile(input), source: input };
  }
}

/**
 * Adapter: call a parser's batch `parse()` and yield its sections as a
 * stream. Used when a parser does not implement `parseStream()`.
 */
async function* batchToStream(
  parser: FileParser,
  buffer: Buffer,
  context: ParserContext,
): AsyncIterable<ParserStreamEvent> {
  const { sections, metadata } = await parser.parse(buffer, context);
  for (const section of sections) {
    yield { type: 'section', section };
  }
  if (metadata) yield { type: 'metadata', metadata };
}

/** Populate `markdown` and `tree` on a section produced by a parser. */
function enrichSection(section: Section): Section {
  if (section.blocks.length === 0) return section;
  return {
    ...section,
    markdown: renderMarkdown(section.blocks),
    tree: buildTree(section.blocks),
  };
}
