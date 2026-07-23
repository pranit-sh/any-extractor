import { readFileSync } from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { deflateRawSync } from 'node:zlib';
import yauzl from 'yauzl';
import { describe, expect, it, vi } from 'vitest';
import { parse as detectMime } from 'file-type-mime';
import {
  AnyExtractor,
  UnsupportedFileTypeError,
  extract,
  toMarkdown,
  toText,
  type FileParser,
} from '../src/index';
import { sniffZipMime } from '../src/util';

// ---------------------------------------------------------------------------
// Fixture registry
// ---------------------------------------------------------------------------

const FIXTURES_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures');
const fixturePath = (name: string) => path.join(FIXTURES_DIR, name);
const loadFixture = (name: string) => readFileSync(fixturePath(name));

// ---------------------------------------------------------------------------
// Streaming-ZIP helpers – used to synthesize an xlsx whose local file headers
// hide the identifying `[Content_Types].xml` bytes (general-purpose bit 3).
// ---------------------------------------------------------------------------

interface ZipEntry {
  name: string;
  content: Buffer;
}

/** Read every entry from a ZIP buffer as (name, uncompressed bytes) pairs. */
function readZipEntries(zip: Buffer): Promise<ZipEntry[]> {
  return new Promise((resolve, reject) => {
    yauzl.fromBuffer(zip, { lazyEntries: true }, (err, zipfile) => {
      if (err) return reject(err);
      const out: ZipEntry[] = [];
      zipfile.readEntry();
      zipfile.on('entry', (entry: yauzl.Entry) => {
        zipfile.openReadStream(entry, (streamErr, stream) => {
          if (streamErr) return reject(streamErr);
          const chunks: Buffer[] = [];
          stream.on('data', (c: Buffer) => chunks.push(c));
          stream.on('end', () => {
            out.push({ name: entry.fileName, content: Buffer.concat(chunks) });
            zipfile.readEntry();
          });
          stream.on('error', reject);
        });
      });
      zipfile.on('end', () => resolve(out));
      zipfile.on('error', reject);
    });
  });
}

/**
 * Write entries to a ZIP that mimics a streaming writer: local file headers
 * with general-purpose bit 3 set and zeroed size fields, followed by a data
 * descriptor after each entry's compressed payload. This is the shape that
 * defeats byte-signature MIME sniffers.
 */
function writeStreamingZip(entries: ZipEntry[]): Buffer {
  const parts: Buffer[] = [];
  const centralDirs: Buffer[] = [];
  let offset = 0;
  const CRC32_TABLE = (() => {
    const table = new Uint32Array(256);
    for (let i = 0; i < 256; i++) {
      let c = i;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      table[i] = c >>> 0;
    }
    return table;
  })();
  const crc32 = (buf: Buffer): number => {
    let c = 0xffffffff;
    for (let i = 0; i < buf.length; i++) c = CRC32_TABLE[(c ^ buf[i]) & 0xff]! ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  };

  for (const entry of entries) {
    const nameBuf = Buffer.from(entry.name, 'utf8');
    const compressed = deflateRawSync(entry.content);
    const crc = crc32(entry.content);

    // Local file header: sizes zeroed, general-purpose bit 3 set (0x0008).
    const localHeader = Buffer.alloc(30);
    localHeader.writeUInt32LE(0x04034b50, 0); // signature
    localHeader.writeUInt16LE(20, 4); // version needed
    localHeader.writeUInt16LE(0x0008, 6); // flags — bit 3 = data descriptor
    localHeader.writeUInt16LE(8, 8); // deflate
    localHeader.writeUInt16LE(0, 10); // mod time
    localHeader.writeUInt16LE(0, 12); // mod date
    localHeader.writeUInt32LE(0, 14); // crc — deferred
    localHeader.writeUInt32LE(0, 18); // compressed — deferred
    localHeader.writeUInt32LE(0, 22); // uncompressed — deferred
    localHeader.writeUInt16LE(nameBuf.length, 26);
    localHeader.writeUInt16LE(0, 28); // extra len

    // Data descriptor (post-payload, real sizes go here).
    const descriptor = Buffer.alloc(16);
    descriptor.writeUInt32LE(0x08074b50, 0); // descriptor signature
    descriptor.writeUInt32LE(crc, 4);
    descriptor.writeUInt32LE(compressed.length, 8);
    descriptor.writeUInt32LE(entry.content.length, 12);

    const localOffset = offset;
    parts.push(localHeader, nameBuf, compressed, descriptor);
    offset += localHeader.length + nameBuf.length + compressed.length + descriptor.length;

    // Central directory entry — this one carries the real sizes/crc so
    // yauzl can still read the archive back.
    const centralHeader = Buffer.alloc(46);
    centralHeader.writeUInt32LE(0x02014b50, 0);
    centralHeader.writeUInt16LE(20, 4); // version made by
    centralHeader.writeUInt16LE(20, 6); // version needed
    centralHeader.writeUInt16LE(0x0008, 8); // flags
    centralHeader.writeUInt16LE(8, 10); // deflate
    centralHeader.writeUInt16LE(0, 12);
    centralHeader.writeUInt16LE(0, 14);
    centralHeader.writeUInt32LE(crc, 16);
    centralHeader.writeUInt32LE(compressed.length, 20);
    centralHeader.writeUInt32LE(entry.content.length, 24);
    centralHeader.writeUInt16LE(nameBuf.length, 28);
    centralHeader.writeUInt16LE(0, 30); // extra len
    centralHeader.writeUInt16LE(0, 32); // comment len
    centralHeader.writeUInt16LE(0, 34); // disk number
    centralHeader.writeUInt16LE(0, 36); // internal attrs
    centralHeader.writeUInt32LE(0, 38); // external attrs
    centralHeader.writeUInt32LE(localOffset, 42);
    centralDirs.push(centralHeader, nameBuf);
  }

  const centralStart = offset;
  const centralBlock = Buffer.concat(centralDirs);
  parts.push(centralBlock);

  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(0, 4);
  eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(centralBlock.length, 12);
  eocd.writeUInt32LE(centralStart, 16);
  eocd.writeUInt16LE(0, 20);
  parts.push(eocd);

  return Buffer.concat(parts);
}

interface FixtureSpec {
  file: string;
  mime: string;
  expectedSections: number;
  /** Kind of the first section. */
  firstSectionKind: string;
  /** Block types that must appear anywhere in the document. */
  requiredBlockTypes: readonly string[];
  /** Substrings that must appear in the flat markdown. */
  markdownContains: readonly string[];
  /** Substrings that must never appear (e.g. stripped script/style). */
  markdownExcludes?: readonly string[];
  /** Extra format-specific assertions. */
  extra?: (result: Awaited<ReturnType<typeof extract>>) => void | Promise<void>;
}

const FIXTURES: readonly FixtureSpec[] = [
  {
    file: 'sample.txt',
    mime: 'text/plain',
    expectedSections: 1,
    firstSectionKind: 'body',
    requiredBlockTypes: ['paragraph'],
    markdownContains: [],
    extra: (r) => {
      expect(r.sections[0].blocks.length).toBeGreaterThanOrEqual(3);
    },
  },
  {
    // Markdown is dispatched by extension; MIME is reported as text/plain.
    file: 'sample.md',
    mime: 'text/plain',
    expectedSections: 1,
    firstSectionKind: 'body',
    requiredBlockTypes: ['heading', 'list', 'paragraph'],
    markdownContains: ['Sample Document'],
    extra: (r) => {
      const headings = r.sections[0].blocks.filter((b) => b.type === 'heading');
      expect(headings.length).toBeGreaterThanOrEqual(2);
    },
  },
  {
    // HTML is dispatched by extension; the outer MIME is reported as text/plain.
    file: 'sample.html',
    mime: 'text/plain',
    expectedSections: 1,
    firstSectionKind: 'body',
    requiredBlockTypes: ['heading', 'paragraph', 'list'],
    markdownContains: ['Main Title'],
    markdownExcludes: ['console.log', 'color: red'],
  },
  {
    // JSON is passed through as-is inside a paragraph block.
    file: 'sample.json',
    mime: 'text/plain',
    expectedSections: 1,
    firstSectionKind: 'body',
    requiredBlockTypes: ['paragraph'],
    markdownContains: ['"any-extractor"'],
  },
  {
    // CSV rows are surfaced as paragraphs; content is preserved verbatim.
    file: 'sample.csv',
    mime: 'text/plain',
    expectedSections: 1,
    firstSectionKind: 'body',
    requiredBlockTypes: ['paragraph'],
    markdownContains: ['name', 'age', 'city', 'Manchester, UK'],
  },
  {
    file: 'sample.docx',
    mime: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    expectedSections: 1,
    firstSectionKind: 'body',
    requiredBlockTypes: ['heading', 'paragraph'],
    markdownContains: ['Quarterly Report', 'Findings', 'Revenue is up 18%'],
    extra: (r) => {
      expect(typeof r.metadata.author).toBe('string');
      expect(r.metadata.author).toBeTruthy();
    },
  },
  {
    file: 'sample.xlsx',
    mime: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    expectedSections: 2,
    firstSectionKind: 'sheet',
    requiredBlockTypes: ['table'],
    markdownContains: ['Region', 'Revenue', 'APAC', 'EMEA', 'North', 'South'],
    extra: (r) => {
      expect(r.sections.every((s) => s.kind === 'sheet')).toBe(true);
      expect(r.sections.map((s) => s.label)).toEqual(['Q1', 'Q2']);
      expect(r.sections.map((s) => s.index)).toEqual([1, 2]);
      expect(r.metadata.sheetNames).toEqual(['Q1', 'Q2']);
      for (const section of r.sections) {
        expect(section.blocks).toHaveLength(1);
        expect(section.blocks[0].type).toBe('table');
      }
    },
  },
  {
    file: 'sample.pptx',
    mime: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
    expectedSections: 2,
    firstSectionKind: 'slide',
    requiredBlockTypes: ['paragraph'],
    markdownContains: ['Intro', 'Welcome to the deck', 'Results', 'Revenue is up 18%'],
    extra: (r) => {
      expect(r.sections.every((s) => s.kind === 'slide')).toBe(true);
      expect(r.sections.map((s) => s.index)).toEqual([1, 2]);
      expect(r.metadata.slideCount).toBe(2);
    },
  },
  {
    file: 'sample.pdf',
    mime: 'application/pdf',
    expectedSections: 1,
    firstSectionKind: 'page',
    requiredBlockTypes: ['paragraph'],
    markdownContains: ['Hello from any-extractor PDF fixture'],
    extra: (r) => {
      expect(r.metadata.pageCount).toBe(1);
      expect(r.sections[0].index).toBe(1);
    },
  },
];

function sniff(buffer: Buffer): string | undefined {
  const ab = buffer.buffer.slice(
    buffer.byteOffset,
    buffer.byteOffset + buffer.byteLength,
  ) as ArrayBuffer;
  return detectMime(ab)?.mime;
}

// ---------------------------------------------------------------------------
// Public API surface
// ---------------------------------------------------------------------------

describe('public API surface', () => {
  it('exports the documented runtime symbols', async () => {
    const api = await import('../src/index');
    expect(typeof api.extract).toBe('function');
    expect(typeof api.AnyExtractor).toBe('function'); // class constructor
    expect(typeof api.UnsupportedFileTypeError).toBe('function');
  });

  it('UnsupportedFileTypeError is a proper Error subclass carrying the mime', () => {
    const err = new UnsupportedFileTypeError('application/x-nope');
    expect(err).toBeInstanceOf(Error);
    expect(err).toBeInstanceOf(UnsupportedFileTypeError);
    expect(err.name).toBe('UnsupportedFileTypeError');
    expect(err.mime).toBe('application/x-nope');
    expect(err.message).toContain('application/x-nope');
  });

  it('AnyExtractor exposes extract and addParser methods', () => {
    const extractor = new AnyExtractor();
    expect(typeof extractor.extract).toBe('function');
    expect(typeof extractor.addParser).toBe('function');
  });

  it('extract() and AnyExtractor#extract() return the same shape', async () => {
    const buf = Buffer.from('hello world\n\nsecond paragraph\n', 'utf-8');
    const a = await extract(buf);
    const b = await new AnyExtractor().extract(buf);

    for (const r of [a, b]) {
      expect(r).toHaveProperty('markdown');
      expect(r).toHaveProperty('sections');
      expect(r).toHaveProperty('metadata');
      expect(Array.isArray(r.sections)).toBe(true);
      expect(r.metadata.mime).toBe('text/plain');
    }
  });
});

// ---------------------------------------------------------------------------
// Fixture-driven extraction (text, markup, Office, PDF)
// ---------------------------------------------------------------------------

describe.each(FIXTURES)('extract($file)', (spec) => {
  it(`sniffs and parses ${spec.file} as ${spec.mime}`, async () => {
    const buffer = loadFixture(spec.file);

    // The MIME sniffer should agree with the reported metadata (text/markup
    // files may be identified via extension rather than magic bytes — so only
    // enforce this for binary formats).
    if (spec.mime.startsWith('application/')) {
      expect(sniff(buffer)).toBe(spec.mime);
    }

    const result = await extract(fixturePath(spec.file));

    expect(result.metadata.mime).toBe(spec.mime);
    expect(result.metadata.source).toContain(spec.file);
    expect(typeof result.markdown).toBe('string');
    expect(result.markdown.length).toBeGreaterThan(0);

    expect(result.sections).toHaveLength(spec.expectedSections);
    expect(result.sections[0].kind).toBe(spec.firstSectionKind);

    const allTypes = new Set(result.sections.flatMap((s) => s.blocks.map((b) => b.type)));
    for (const t of spec.requiredBlockTypes) {
      expect(allTypes).toContain(t);
    }

    for (const needle of spec.markdownContains) {
      expect(result.markdown).toContain(needle);
    }
    for (const forbidden of spec.markdownExcludes ?? []) {
      expect(result.markdown).not.toContain(forbidden);
    }

    // Every section's markdown prefix must appear in the flat document markdown.
    for (const section of result.sections) {
      const prefix = toMarkdown(section).trim().slice(0, 20);
      if (prefix.length > 0) {
        expect(result.markdown).toContain(prefix);
      }
    }

    // Deterministic block ids across runs.
    const second = await extract(fixturePath(spec.file));
    const idsA = result.sections.flatMap((s) => s.blocks.map((b) => b.id));
    const idsB = second.sections.flatMap((s) => s.blocks.map((b) => b.id));
    expect(idsA).toEqual(idsB);
    for (const id of idsA) {
      expect(id).toMatch(/^[a-f0-9]+$/i);
      expect(id.length).toBeGreaterThan(4);
    }

    await spec.extra?.(result);
  });
});

// ---------------------------------------------------------------------------
// Cross-cutting behaviors: input shapes, errors, custom parser registry
// ---------------------------------------------------------------------------

describe('extract() – input shapes and errors', () => {
  it('accepts a Buffer and reports source as "buffer"', async () => {
    const buffer = loadFixture('sample.md');
    const result = await extract(buffer);

    expect(result.metadata.source).toBe('buffer');
    expect(result.sections[0].blocks.length).toBeGreaterThan(0);
  });

  it('fetches http(s) URLs via fetch and reports the URL as source', async () => {
    const url = 'https://example.com/sample.md';
    const body = loadFixture('sample.md');

    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () =>
      new Response(body, {
        status: 200,
        headers: { 'content-type': 'text/markdown' },
      })) as typeof fetch;

    try {
      const result = await extract(url);
      expect(result.metadata.source).toBe(url);
      expect(result.sections[0].blocks.some((b) => b.type === 'heading')).toBe(true);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('throws on an empty buffer', async () => {
    await expect(extract(Buffer.alloc(0))).rejects.toThrow(/empty/);
  });

  it('handles unrecognized bytes gracefully or with UnsupportedFileTypeError', async () => {
    // Non-magic-byte input. In practice this falls through to text/plain, so
    // extraction should succeed; if it doesn't, the failure must be typed.
    const buffer = Buffer.from([0x00, 0x01, 0x02, 0x03, 0x89, 0xab, 0xcd, 0xef]);
    let threw: unknown;
    try {
      const result = await extract(buffer);
      expect(result.metadata.mime).toBeDefined();
    } catch (err) {
      threw = err;
    }
    if (threw) {
      expect(threw).toBeInstanceOf(UnsupportedFileTypeError);
      expect((threw as UnsupportedFileTypeError).mime).toBeTypeOf('string');
    }
  });

  it('throws UnsupportedFileTypeError when no parser matches (WebP)', async () => {
    const webp = Buffer.concat([
      Buffer.from('RIFF'),
      Buffer.from([0x1a, 0x00, 0x00, 0x00]),
      Buffer.from('WEBPVP8 '),
      Buffer.alloc(16, 0),
    ]);

    await expect(new AnyExtractor().extract(webp)).rejects.toBeInstanceOf(UnsupportedFileTypeError);

    try {
      await new AnyExtractor().extract(webp);
    } catch (err) {
      expect((err as UnsupportedFileTypeError).mime).toMatch(/webp|image/);
    }
  });

  it('rejects non-string, non-Buffer inputs with a clear TypeError', async () => {
    const extractor = new AnyExtractor();
    // @ts-expect-error – intentionally wrong input type
    await expect(extractor.extract(42)).rejects.toBeInstanceOf(TypeError);
  });
});

// ---------------------------------------------------------------------------
// ZIP-content MIME sniffing – rescues OOXML/ODF documents whose outer ZIP
// header hides the identifying bytes (e.g. streaming-ZIP xlsx exports).
// ---------------------------------------------------------------------------

describe('sniffZipMime – ZIP-content fallback for OOXML / ODF', () => {
  it('identifies xlsx from `xl/workbook.xml`', async () => {
    const mime = await sniffZipMime(loadFixture('sample.xlsx'));
    expect(mime).toBe('application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  });

  it('identifies docx from `word/document.xml`', async () => {
    const mime = await sniffZipMime(loadFixture('sample.docx'));
    expect(mime).toBe('application/vnd.openxmlformats-officedocument.wordprocessingml.document');
  });

  it('identifies pptx from `ppt/presentation.xml`', async () => {
    const mime = await sniffZipMime(loadFixture('sample.pptx'));
    expect(mime).toBe('application/vnd.openxmlformats-officedocument.presentationml.presentation');
  });

  it('returns undefined for a plain ZIP with no recognizable OOXML/ODF parts', async () => {
    // Minimal empty ZIP: end-of-central-directory record only (22 bytes).
    const emptyZip = Buffer.from([
      0x50, 0x4b, 0x05, 0x06, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
    ]);
    const mime = await sniffZipMime(emptyZip);
    expect(mime).toBeUndefined();
  });

  it('recovers on a streaming-ZIP xlsx that file-type-mime cannot classify', async () => {
    // Rewrite `sample.xlsx` entries into a streaming-ZIP archive (general-
    // purpose bit 3 set, sizes deferred to data descriptors). That is the
    // shape modern Excel exports produce and the shape that fools
    // `file-type-mime` into reporting `application/zip`. If the extractor
    // still routes the archive to the xlsx parser, the fallback works.
    const entries = await readZipEntries(loadFixture('sample.xlsx'));
    const streamingZip = writeStreamingZip(entries);

    // Sanity: outer sniff really does fall back to `application/zip`.
    const outer = detectMime(
      streamingZip.buffer.slice(
        streamingZip.byteOffset,
        streamingZip.byteOffset + streamingZip.byteLength,
      ) as ArrayBuffer,
    );
    expect(outer?.mime).toBe('application/zip');

    const result = await new AnyExtractor().extract(streamingZip);
    expect(result.metadata.mime).toBe(
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    );
    expect(result.sections.length).toBeGreaterThan(0);
  });
});

describe('AnyExtractor class – custom parser registry', () => {
  // Smallest valid 1x1 PNG – file-type-mime sniffs as image/png.
  const png = Buffer.from(
    '89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4' +
      '89000000097048597300002e2300002e230178a53f760000000d49444154789c' +
      '63000100000005000106b024000000000049454e44ae426082',
    'hex',
  );

  it('routes to a custom parser registered for a new MIME (image/png)', async () => {
    const parser: FileParser = {
      mimes: ['image/png'],
      parse: vi.fn(async (_buffer, ctx) => ({
        sections: [
          {
            kind: 'body' as const,
            blocks: [ctx.block.paragraph('caption from vision model')],
          },
        ],
        metadata: { title: 'my-image' },
      })),
    };

    const extractor = new AnyExtractor().addParser(parser);
    const result = await extractor.extract(png);

    expect(parser.parse).toHaveBeenCalledOnce();
    expect(result.metadata.mime).toBe('image/png');
    expect(result.metadata.title).toBe('my-image');
    expect(result.sections[0].blocks[0].type).toBe('paragraph');
    expect(result.markdown).toContain('caption from vision model');
  });

  it('lets user parsers override a built-in MIME (text/plain)', async () => {
    const custom: FileParser = {
      mimes: ['text/plain'],
      parse: async (_buf, ctx) => ({
        sections: [
          {
            kind: 'body',
            blocks: [ctx.block.paragraph('OVERRIDDEN')],
          },
        ],
      }),
    };

    const extractor = new AnyExtractor().addParser(custom);
    const result = await extractor.extract(fixturePath('sample.txt'));

    expect(result.markdown).toContain('OVERRIDDEN');
    expect(result.sections[0].blocks).toHaveLength(1);
  });

  it('lets user parsers override a built-in binary MIME (docx)', async () => {
    const DOCX_MIME = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
    const extractor = new AnyExtractor().addParser({
      mimes: [DOCX_MIME],
      parse: async (_buf, ctx) => ({
        sections: [
          {
            kind: 'body',
            blocks: [ctx.block.paragraph('CUSTOM DOCX OUTPUT')],
          },
        ],
      }),
    });

    const result = await extractor.extract(loadFixture('sample.docx'));
    expect(result.markdown).toContain('CUSTOM DOCX OUTPUT');
    expect(result.markdown).not.toMatch(/Quarterly Report/);
  });

  it('honours a user PDF parser override (multi-page dispatch)', async () => {
    const extractor = new AnyExtractor().addParser({
      mimes: ['application/pdf'],
      parse: async (_buf, ctx) => ({
        sections: [
          {
            kind: 'page',
            index: 1,
            label: 'Page 1',
            blocks: [ctx.block.paragraph('one')],
          },
          {
            kind: 'page',
            index: 2,
            label: 'Page 2',
            blocks: [ctx.block.paragraph('two')],
          },
        ],
        metadata: { pageCount: 2 },
      }),
    });

    const result = await extractor.extract(loadFixture('sample.pdf'));
    expect(result.sections).toHaveLength(2);
    expect(result.metadata.pageCount).toBe(2);
    expect(result.markdown).toMatch(/one/);
    expect(result.markdown).toMatch(/two/);
  });

  it('addParser returns `this` for chaining', () => {
    const extractor = new AnyExtractor();
    const returned = extractor.addParser({
      mimes: ['application/x-fake'],
      parse: async () => ({ sections: [] }),
    });
    expect(returned).toBe(extractor);
  });

  it('drops sections whose blocks are empty and renders per-section markdown', async () => {
    const parser: FileParser = {
      mimes: ['image/png'],
      parse: async (_buf, ctx) => ({
        sections: [
          { kind: 'body', blocks: [] }, // should be dropped
          {
            kind: 'body',
            blocks: [ctx.block.heading(2, 'Hello')],
          },
        ],
      }),
    };
    const extractor = new AnyExtractor().addParser(parser);
    const result = await extractor.extract(png);

    expect(result.sections).toHaveLength(1);
    expect(toMarkdown(result.sections[0])).toMatch(/^##\s+Hello/m);
    expect(result.markdown.trim()).toMatch(/^##\s+Hello/m);
  });

  it('exposes a working ctx.parseImage that runs registered image parsers', async () => {
    const observed: Array<string | undefined> = [];

    const imageParser: FileParser = {
      mimes: ['image/png'],
      parse: async (_buf, ctx) => ({
        sections: [
          {
            kind: 'body',
            blocks: [ctx.block.paragraph('vision-text')],
          },
        ],
      }),
    };

    const containerParser: FileParser = {
      mimes: ['text/plain'],
      parse: async (_buf, ctx) => {
        const text = await ctx.parseImage(Buffer.from('fake'), 'image/png');
        observed.push(text);
        return {
          sections: [
            {
              kind: 'body',
              blocks: [ctx.block.paragraph(text ?? '<none>')],
            },
          ],
        };
      },
    };

    const extractor = new AnyExtractor().addParser(imageParser).addParser(containerParser);
    const result = await extractor.extract(fixturePath('sample.txt'));

    expect(observed[0]).toBe('vision-text');
    expect(result.markdown).toContain('vision-text');
  });
});

// ---------------------------------------------------------------------------
// Result shape: blocks are the source of truth, markdown is derived lazily
// ---------------------------------------------------------------------------

describe('result shape – lazy markdown, no per-section duplicate', () => {
  it('does not store a `markdown` field on sections', async () => {
    const result = await extract(Buffer.from('hello\n\nworld', 'utf-8'));
    for (const section of result.sections) {
      expect(section).not.toHaveProperty('markdown');
    }
  });

  it('exposes `result.markdown` as a stable, cached getter', async () => {
    const result = await extract(Buffer.from('hello\n\nworld', 'utf-8'));
    const a = result.markdown;
    const b = result.markdown;
    expect(a).toBe(b); // same reference => cached
    expect(a).toContain('hello');
    expect(a).toContain('world');
  });

  it('renders per-section markdown on demand via `toMarkdown`', async () => {
    const result = await extract(Buffer.from('# Title\n\nBody paragraph', 'utf-8'));
    const rendered = toMarkdown(result.sections[0]);
    expect(rendered).toMatch(/^# Title/m);
    // Same helper works on a raw block array too.
    expect(toMarkdown(result.sections[0].blocks)).toBe(rendered);
  });
});

// ---------------------------------------------------------------------------
// Plain-text rendering: `result.text` and `toText`
// ---------------------------------------------------------------------------

describe('plain text rendering – result.text and toText', () => {
  it('exposes `result.text` as a stable, cached getter with no markdown syntax', async () => {
    const result = await extract(
      Buffer.from('# Title\n\nBody **bold** and *italic* and `code`', 'utf-8'),
    );
    const a = result.text;
    const b = result.text;
    expect(a).toBe(b); // cached

    expect(a).toContain('Title');
    expect(a).toContain('Body bold and italic and code');
    // No markdown scaffolding survives.
    expect(a).not.toMatch(/[#*_`]/);
  });

  it('strips inline markdown from paragraphs and list items', async () => {
    const extractor = new AnyExtractor().addParser({
      mimes: ['text/plain'],
      parse: async (_buf, ctx) => ({
        sections: [
          {
            kind: 'body',
            blocks: [
              ctx.block.heading(1, 'Report'),
              ctx.block.paragraph('Sales up **18%** (see [table 3](#t3)).'),
              ctx.block.list(['first **item**', '`inline` code', '[link](https://x)']),
            ],
          },
        ],
      }),
    });
    const result = await extractor.extract(Buffer.from('anything', 'utf-8'));

    expect(result.text).toBe(
      ['Report', 'Sales up 18% (see table 3).', 'first item\ninline code\nlink'].join('\n\n'),
    );
  });

  it('renders tables as tab-separated rows (headers first when present)', async () => {
    const extractor = new AnyExtractor().addParser({
      mimes: ['text/plain'],
      parse: async (_buf, ctx) => ({
        sections: [
          {
            kind: 'body',
            blocks: [
              ctx.block.table(
                [
                  ['APAC', '100'],
                  ['EMEA', '200'],
                ],
                { headers: ['Region', 'Revenue'] },
              ),
            ],
          },
        ],
      }),
    });
    const result = await extractor.extract(Buffer.from('anything', 'utf-8'));
    expect(result.text).toBe('Region\tRevenue\nAPAC\t100\nEMEA\t200');
  });

  it('separates sections with a blank line and no divider', async () => {
    const extractor = new AnyExtractor().addParser({
      mimes: ['text/plain'],
      parse: async (_buf, ctx) => ({
        sections: [
          { kind: 'page', index: 1, blocks: [ctx.block.paragraph('one')] },
          { kind: 'page', index: 2, blocks: [ctx.block.paragraph('two')] },
        ],
      }),
    });
    const result = await extractor.extract(Buffer.from('anything', 'utf-8'));
    expect(result.text).toBe('one\n\n\ntwo');
    expect(result.text).not.toContain('---');
  });

  it('`toText` accepts a Section or a raw Block[] and matches the section render', async () => {
    const result = await extract(Buffer.from('# Title\n\nBody paragraph', 'utf-8'));
    const viaSection = toText(result.sections[0]);
    const viaBlocks = toText(result.sections[0].blocks);
    expect(viaSection).toBe(viaBlocks);
    expect(viaSection).toContain('Title');
    expect(viaSection).toContain('Body paragraph');
  });

  it('leaves word-internal underscores and stars alone', async () => {
    const extractor = new AnyExtractor().addParser({
      mimes: ['text/plain'],
      parse: async (_buf, ctx) => ({
        sections: [
          {
            kind: 'body',
            blocks: [ctx.block.paragraph('snake_case_name and 2*3*4 and file_a_b')],
          },
        ],
      }),
    });
    const result = await extractor.extract(Buffer.from('anything', 'utf-8'));
    expect(result.text).toBe('snake_case_name and 2*3*4 and file_a_b');
  });
});

// ---------------------------------------------------------------------------
// Per-parser concurrency
// ---------------------------------------------------------------------------

describe('FileParser.concurrency – per-parser rate cap', () => {
  /**
   * A slow image parser that increments a shared counter on entry,
   * awaits a controllable deferred, and decrements on exit. The test
   * then asserts the peak counter never exceeded the configured limit.
   * Pass `concurrency` to declare the parser's own cap.
   */
  function makeInstrumentedImageParser(concurrency?: number): {
    parser: FileParser;
    peak: () => number;
    release: () => void;
  } {
    let active = 0;
    let peak = 0;
    let resolveAll: (() => void) | undefined;
    const gate = new Promise<void>((r) => {
      resolveAll = r;
    });
    const parser: FileParser = {
      mimes: ['image/png'],
      ...(concurrency !== undefined ? { concurrency } : {}),
      parse: async (_buf, ctx) => {
        active++;
        if (active > peak) peak = active;
        await gate;
        active--;
        return {
          sections: [{ kind: 'body', blocks: [ctx.block.paragraph('caption')] }],
        };
      },
    };
    return { parser, peak: () => peak, release: () => resolveAll?.() };
  }

  /** A container parser that fires N ctx.parseImage calls in parallel. */
  function makeParallelImageContainer(count: number): FileParser {
    return {
      mimes: ['text/plain'],
      parse: async (_buf, ctx) => {
        const calls = Array.from({ length: count }, () =>
          ctx.parseImage(Buffer.from('x'), 'image/png'),
        );
        const texts = await Promise.all(calls);
        return {
          sections: [
            {
              kind: 'body',
              blocks: texts
                .filter((t): t is string => Boolean(t))
                .map((t) => ctx.block.paragraph(t)),
            },
          ],
        };
      },
    };
  }

  it('caps parallel calls at the parser-declared concurrency', async () => {
    const { parser: imageParser, peak, release } = makeInstrumentedImageParser(3);
    const container = makeParallelImageContainer(10);

    const extractor = new AnyExtractor().addParser(imageParser).addParser(container);
    const promise = extractor.extract(Buffer.from('anything', 'utf-8'));

    // Give the container parser a couple of microtask ticks to line up
    // all 10 parseImage calls behind the semaphore.
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));

    expect(peak()).toBeLessThanOrEqual(3);

    release();
    const result = await promise;
    expect(result.sections[0].blocks).toHaveLength(10);
    expect(peak()).toBeLessThanOrEqual(3);
  });

  it('runs unbounded when a parser does not declare concurrency', async () => {
    const { parser: imageParser, peak, release } = makeInstrumentedImageParser();
    const container = makeParallelImageContainer(10);

    const extractor = new AnyExtractor().addParser(imageParser).addParser(container);
    const promise = extractor.extract(Buffer.from('anything', 'utf-8'));

    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));

    expect(peak()).toBe(10);

    release();
    await promise;
  });

  it('treats concurrency of 0 or Infinity as unbounded', async () => {
    for (const setting of [0, Infinity]) {
      const { parser: imageParser, peak, release } = makeInstrumentedImageParser(setting);
      const container = makeParallelImageContainer(10);

      const extractor = new AnyExtractor().addParser(imageParser).addParser(container);
      const promise = extractor.extract(Buffer.from('anything', 'utf-8'));

      await new Promise((r) => setImmediate(r));
      await new Promise((r) => setImmediate(r));

      expect(peak()).toBe(10);

      release();
      await promise;
    }
  });

  it('processes every image even when N > limit (queue drains fully)', async () => {
    // Non-blocking image parser this time so the test can complete.
    let seen = 0;
    const imageParser: FileParser = {
      mimes: ['image/png'],
      concurrency: 3,
      parse: async (_buf, ctx) => {
        seen++;
        return {
          sections: [{ kind: 'body', blocks: [ctx.block.paragraph('ok')] }],
        };
      },
    };
    const container = makeParallelImageContainer(20);
    const extractor = new AnyExtractor().addParser(imageParser).addParser(container);
    const result = await extractor.extract(Buffer.from('anything', 'utf-8'));
    expect(seen).toBe(20);
    expect(result.sections[0].blocks).toHaveLength(20);
  });
});

// ---------------------------------------------------------------------------
// Cancellation & timeout
// ---------------------------------------------------------------------------
describe('extract() cancellation & timeout', () => {
  it('rejects with AbortError when the signal is already aborted', async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(
      extract(Buffer.from('hello world', 'utf-8'), { signal: controller.signal }),
    ).rejects.toMatchObject({ name: 'AbortError' });
  });

  it('rejects mid-parse when the signal aborts', async () => {
    const extractor = new AnyExtractor().addParser({
      mimes: ['text/plain'],
      parse: async (_buf, ctx) => {
        await new Promise((r) => setTimeout(r, 30));
        return {
          sections: [{ kind: 'body', blocks: [ctx.block.paragraph('done')] }],
        };
      },
    });
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 5);
    await expect(
      extractor.extract(Buffer.from('anything', 'utf-8'), { signal: controller.signal }),
    ).rejects.toMatchObject({ name: 'AbortError' });
  });

  it('rejects with TimeoutError when timeoutMs elapses', async () => {
    const extractor = new AnyExtractor().addParser({
      mimes: ['text/plain'],
      parse: async (_buf, ctx) => {
        await new Promise((r) => setTimeout(r, 50));
        return {
          sections: [{ kind: 'body', blocks: [ctx.block.paragraph('done')] }],
        };
      },
    });
    await expect(
      extractor.extract(Buffer.from('anything', 'utf-8'), { timeoutMs: 5 }),
    ).rejects.toMatchObject({ name: 'TimeoutError' });
  });

  it('completes normally when timeout is generous', async () => {
    const result = await extract(Buffer.from('hello world', 'utf-8'), { timeoutMs: 5000 });
    expect(result.text).toContain('hello world');
  });

  it('ignores non-positive timeoutMs values', async () => {
    for (const timeoutMs of [0, -1, Number.NaN]) {
      const result = await extract(Buffer.from('hi', 'utf-8'), { timeoutMs });
      expect(result.text).toBe('hi');
    }
  });
});
