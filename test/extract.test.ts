import { readFileSync } from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
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

// ---------------------------------------------------------------------------
// Fixture registry
// ---------------------------------------------------------------------------

const FIXTURES_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures');
const fixturePath = (name: string) => path.join(FIXTURES_DIR, name);
const loadFixture = (name: string) => readFileSync(fixturePath(name));

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
