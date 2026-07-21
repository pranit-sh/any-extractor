# any-extractor

[![NPM Version](https://img.shields.io/npm/v/any-extractor)](https://www.npmjs.com/package/any-extractor)
[![License](https://img.shields.io/npm/l/any-extractor)](https://www.npmjs.com/package/any-extractor)
[![Downloads](https://img.shields.io/npm/dm/any-extractor)](https://www.npmjs.com/package/any-extractor)

Structured document extraction for AI agents. Feed PDFs, Word docs,
spreadsheets, slides, and text into your LLM as clean **GitHub-flavored
markdown** — plus a typed **block tree** with positional metadata (page
numbers, section paths, slide indexes) when you need more than a flat string.

```ts
import { extract } from 'any-extractor';

const { markdown } = await extract('./resume.pdf');
console.log(markdown);
```

## Why

LLMs and RAG pipelines need consistent, structured input across formats. Raw
text loses tables, headings, and layout. `any-extractor` gives you:

- **Markdown-first output** — GFM tables, headings, lists, code, quotes,
  images. Drop-in for any chat completion API.
- **Structured blocks** — every table, heading, list item is a typed `Block`
  with a stable id and position (`page`, `sectionPath`). Chunk, cite, or
  re-render however you like.
- **Heading-rooted tree** — every section exposes a `tree` view so agents
  can grab "everything under `## Results`" without re-parsing markdown.
- **Layout-aware PDF reading order** — multi-column pages are split into
  columns and serialized top-to-bottom, left-to-right.
- **One API, many formats** — PDF, DOCX, XLSX, PPTX, ODF, plain text, HTML,
  JSON, CSV, Markdown.
- **Tiny surface** — two functions cover 90% of use cases. No config required.

## Install

```bash
npm install any-extractor
```

Requires Node.js **18+**.

## Supported formats

| Format                                | MIME                                                                        |
| ------------------------------------- | --------------------------------------------------------------------------- |
| PDF (`.pdf`)                          | `application/pdf`                                                           |
| Word (`.docx`)                        | `application/vnd.openxmlformats-officedocument.wordprocessingml.document`   |
| Excel (`.xlsx`)                       | `application/vnd.openxmlformats-officedocument.spreadsheetml.sheet`         |
| PowerPoint (`.pptx`)                  | `application/vnd.openxmlformats-officedocument.presentationml.presentation` |
| OpenDocument (`.odt`, `.ods`, `.odp`) | `application/vnd.oasis.opendocument.*`                                      |
| Plain text / Markdown (`.txt`, `.md`) | `text/plain`, `text/markdown`                                               |
| HTML (`.html`)                        | `text/html`                                                                 |
| CSV (`.csv`)                          | `text/csv`                                                                  |
| JSON (`.json`)                        | `application/json`                                                          |

Unrecognized binary files throw `UnsupportedFileTypeError` — no silent
fallbacks.

## Quick start

### Just the markdown

```ts
import { extract } from 'any-extractor';

const { markdown } = await extract('./quarterly-report.pdf');
// send `markdown` to your LLM
```

### The full structured result

```ts
import { extract } from 'any-extractor';

const { markdown, sections, metadata } = await extract('./deck.pptx');

for (const section of sections) {
  console.log(section.kind, section.label, section.blocks.length);
}
```

### From a `Buffer` or a URL

```ts
await extract(fs.readFileSync('./doc.docx'));
await extract('https://example.com/report.pdf');
```

## The block model

Every parser normalizes its input into the same shape:

```ts
type ExtractResult = {
  markdown: string; // full document, GFM
  sections: Section[]; // pages / sheets / slides / chapters
  metadata: ExtractMetadata; // title, author, mime, dates, custom
};

type Section = {
  kind: 'page' | 'sheet' | 'slide' | 'chapter' | 'notes' | 'body';
  label?: string; // e.g. sheet name, slide title
  index?: number; // 1-based
  sectionPath?: string[]; // e.g. ['Q1 Sales'] for an XLSX sheet
  blocks: Block[]; // flat, in reading order
  tree: SectionNode[]; // heading-rooted view of the same blocks
  markdown: string; // pre-rendered markdown for this section
};

type Block =
  | HeadingBlock // { level: 1–6, runs }
  | ParagraphBlock // { runs }
  | ListBlock // { ordered, items: ListItem[] }
  | TableBlock // { headers?, rows, raw?, merges? }
  | CodeBlock // { language?, text }
  | QuoteBlock // { blocks }
  | ImageBlock // { alt?, path?, mime, bytes, description? }
  | DividerBlock;
```

Every block carries:

```ts
type BlockBase = {
  id: string; // stable sha1(content) — good for chunk keys
  position: {
    page?: number; // PDF page / slide index / sheet index
    sectionPath?: string[]; // heading trail: ['H1', 'H2.1', ...]
  };
};
```

**Why this matters for agents:** you can chunk by section, cite by block id,
or filter by `position.page` when the LLM asks "what does page 3 say?".

**Alt text and merged cells.** DOCX / XLSX / PPTX alt text on images
(`descr` / `title` on the DrawingML `cNvPr` element) is preserved on
`ImageBlock.alt`. Excel `<mergeCells>` regions are preserved on
`TableBlock.merges`, and the merged value is fanned out across every covered
cell in `rows` / `raw` so retrieval sees it in each position.

### Traversing by heading — `Section.tree`

`section.blocks` is the flat, in-order stream. When you want to reason about
document structure — "give me everything under `## Results`" — walk
`section.tree` instead:

```ts
type SectionNode = {
  level: 0 | 1 | 2 | 3 | 4 | 5 | 6; // 0 = synthetic root for pre-heading content
  heading?: HeadingBlock; // undefined only on the synthetic root
  title?: string; // convenience alias for heading.text
  blocks: Block[]; // non-heading blocks directly under this heading
  children: SectionNode[]; // deeper headings nested here
};

for (const node of section.tree) {
  console.log('  '.repeat(node.level) + (node.title ?? '(preamble)'));
}
```

The tree preserves every block in `section.blocks` — nothing is dropped or
duplicated, just reshaped. Need it standalone? Import `buildTree`:

```ts
import { buildTree } from 'any-extractor';
const tree = buildTree(someBlocks);
```

## Chunking for RAG

Generic text splitters (LangChain, LlamaIndex) work by regexing over a
string — they don't know a table row from a paragraph, and they'll happily
shred a code fence down the middle. `any-extractor` chunks the typed block
stream directly, so it can guarantee things a string-based splitter can't:

- **Atomic blocks are never split.** Tables, code blocks, and images stay
  whole. A single oversized table becomes its own chunk rather than
  getting sliced.
- **Heading boundaries come from the parser**, not a regex. Whether the
  source was DOCX, PDF, or PPTX, a heading is a heading.
- **Real per-chunk provenance.** Each chunk carries the `page` and
  `sectionPath` inherited from its first source block — usable for
  citation UIs without any post-processing.
- **Deterministic ids.** A chunk's id is derived from its constituent
  block ids, so re-extracting the same file yields the same chunk ids —
  safe to upsert into a vector store.

```ts
import { extract, chunk } from 'any-extractor';

const result = await extract('./report.pdf');
const chunks = chunk(result, { maxSize: 2000 });

for (const c of chunks) {
  console.log(c.id, c.page, c.sectionPath, c.size);
  // c.text is markdown, ready to embed
  // c.blocks is the exact source blocks for citations
}
```

### `chunk(result, options?) → Chunk[]`

```ts
type Chunk = {
  id: string; // sha1 of constituent block ids, 16 chars
  text: string; // markdown (may be prefixed with section path)
  blocks: Block[]; // exact source blocks, in order
  index: number; // position in the sequence
  page?: number; // first page any constituent block touches
  sectionPath?: string[]; // e.g. ["Chapter 2", "1.3 Results"]
  size: number; // measured with the configured sizer
};

type ChunkOptions = {
  maxSize?: number; // default 2000 (chars ≈ 500 tokens)
  minSize?: number; // default 200 — avoids tiny orphan chunks
  sizer?: (text: string) => number; // default: (s) => s.length
  includeSectionPath?: boolean; // default true — prepends `> path` to text
};
```

Sizing is character-based by default. If you need model-exact token counts,
pass your own `sizer`:

```ts
import { encoding_for_model } from 'tiktoken';
const enc = encoding_for_model('gpt-4o');
const chunks = chunk(result, {
  maxSize: 800,
  sizer: (s) => enc.encode(s).length,
});
```

Chunks never cross a section boundary — a PDF page's chunks won't merge
with the next page's, and a spreadsheet's sheets stay in separate chunks.

## API

### `extract(input) → Promise<ExtractResult>`

Extracts structured blocks, markdown, and metadata from a file path, URL, or
`Buffer`. URL fetching is credential-free — if you need custom headers, auth,
cookies, or proxies, fetch the bytes yourself and pass the resulting
`Buffer`:

```ts
const buf = Buffer.from(await (await fetch(url, { headers })).arrayBuffer());
const { markdown } = await extract(buf);
```

### `createExtractor() → AnyExtractor`

Build a reusable extractor with all built-in parsers registered. Chain
`.addParser(...)` to plug in your own.

```ts
import { createExtractor, type FileParser } from 'any-extractor';

const extractor = createExtractor().addParser(myCustomParser);

const result = await extractor.extract('./thing.foo');
```

### `chunk(result, options?) → Chunk[]`

Split an `ExtractResult` into retrieval-ready chunks. See
[Chunking for RAG](#chunking-for-rag) above for the full type signature
and behavior notes.

## Custom parsers

Implement `FileParser` to handle additional formats. Anything you register
also participates in **recursive extraction** — for example, register an
image parser and every image embedded in Word/Excel/PowerPoint automatically
gets its markdown attached to `ImageBlock.description`.

```ts
import type { FileParser, ParserContext, ParserResult } from 'any-extractor';

const yamlParser: FileParser = {
  name: 'yaml',
  supports(mime) {
    return mime === 'application/x-yaml' || mime === 'text/yaml';
  },
  async parse(buf, ctx: ParserContext): Promise<ParserResult> {
    return {
      sections: [
        {
          kind: 'body',
          blocks: [ctx.block.code(buf.toString('utf8'), { language: 'yaml' })],
          markdown: '',
        },
      ],
    };
  },
};
```

### Image captioning via a custom parser

Want vision-model captions on embedded images? Register a parser for image
MIME types. The built-in Word/Excel/PowerPoint parsers call `ctx.describe(buf)`
for every embedded image; if a matching parser exists, its markdown becomes
the image's `description`. If not, the image is passed through untouched.

```ts
const imageCaptioner: FileParser = {
  name: 'image-caption',
  supports(mime) {
    return mime.startsWith('image/');
  },
  async parse(buf, ctx: ParserContext): Promise<ParserResult> {
    const caption = await myVisionModel.describe(buf); // your call
    return {
      sections: [{ kind: 'body', blocks: [ctx.block.paragraph(caption)], markdown: '' }],
    };
  },
};

const extractor = createExtractor().addParser(imageCaptioner);
```

## License

Apache-2.0
