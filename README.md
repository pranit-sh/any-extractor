# any-extractor

> One `extract()` call. Any document. Agent-ready markdown + typed blocks + metadata.

[![npm version](https://img.shields.io/npm/v/any-extractor.svg)](https://www.npmjs.com/package/any-extractor)
[![license](https://img.shields.io/npm/l/any-extractor.svg)](./LICENSE)

`any-extractor` turns whatever file you point it at into three things:

1. **`markdown`** — a single GFM string, ready to hand to an LLM.
2. **`sections`** — ordered pages / slides / sheets / body sections, each with typed blocks _and_ their own markdown.
3. **`metadata`** — MIME type, title, author, page/slide counts, sheet names.

No streaming APIs. No chunking. No footguns. It parses the file and gives you clean, structured output — and if you want to bolt in your own parser (vision LLM for images, custom XML dialect, whatever), there's a one-liner for that too.

> **What's new in 3.0**
>
> - Full rewrite around a five-block model (`heading`, `paragraph`, `list`, `table`, `image`) with per-section markdown and stable content-derived ids.
> - New `AnyExtractor` class with `addParser()` — plug in your own MIME handlers (e.g. a vision LLM for images) without forking.
> - Image parsers automatically enrich embedded images inside Word, PowerPoint, and OpenDocument files, rendered as blockquote captions in the output markdown.
> - `UnsupportedFileTypeError` for anything without a parser, so failures are explicit.

## Install

```bash
npm install any-extractor
```

Requires Node.js ≥ 18. Ships with ESM + CJS + `.d.ts`.

## Quick start

```ts
import { extract } from 'any-extractor';

// Path, URL, or Buffer — the extractor sniffs the MIME type itself.
const result = await extract('./quarterly-report.pdf');

console.log(result.metadata.pageCount); // 42
console.log(result.markdown.slice(0, 200));

for (const section of result.sections) {
  console.log(section.kind, section.label); // "page", "Page 3"
  for (const block of section.blocks) {
    if (block.type === 'heading') console.log('#'.repeat(block.level), block.text);
  }
}
```

## Supported formats

| Format       | MIME                                                                        | Sections emitted           |
| ------------ | --------------------------------------------------------------------------- | -------------------------- |
| PDF          | `application/pdf`                                                           | one `page` per page        |
| Word         | `application/vnd.openxmlformats-officedocument.wordprocessingml.document`   | single `body`              |
| Excel        | `application/vnd.openxmlformats-officedocument.spreadsheetml.sheet`         | one `sheet` per worksheet  |
| PowerPoint   | `application/vnd.openxmlformats-officedocument.presentationml.presentation` | one `slide` per slide      |
| OpenDocument | `application/vnd.oasis.opendocument.{text,spreadsheet,presentation}`        | `body` / `sheet` / `slide` |
| HTML         | `text/html`                                                                 | single `body`              |
| Markdown     | `text/markdown`                                                             | single `body`              |
| Plain text   | `text/plain`                                                                | single `body`              |
| CSV          | `text/csv`                                                                  | single `body` (one table)  |
| JSON         | `application/json`                                                          | single `body`              |

## The result shape

```ts
interface ExtractResult {
  markdown: string; // whole document as GFM
  sections: Section[]; // ordered, with per-section markdown
  metadata: ExtractMetadata;
}

interface Section {
  kind: 'body' | 'page' | 'slide' | 'sheet';
  label?: string; // e.g. "Page 3", "Slide 2", "Q1 Sales"
  index?: number; // 1-based within its kind
  blocks: Block[]; // structured content
  markdown: string; // GFM rendering of `blocks`
}

interface ExtractMetadata {
  mime: string;
  source?: string; // file path, URL, or "buffer"
  title?: string;
  author?: string;
  pageCount?: number; // PDF
  slideCount?: number; // PPTX / ODP
  sheetNames?: string[]; // XLSX / ODS
}
```

## The block model

Five block types. That's the whole thing.

```ts
type Block = Heading | Paragraph | List | Table | Image;

interface BlockBase {
  id: string; // stable, content-derived hash
  page?: number; // 1-based, when known
  sectionPath?: string[]; // heading breadcrumb, e.g. ["Chapter 2", "Results"]
}

interface Heading extends BlockBase {
  type: 'heading';
  level: 1 | 2 | 3 | 4 | 5 | 6;
  text: string;
}
interface Paragraph extends BlockBase {
  type: 'paragraph';
  text: string;
} // inline GFM
interface List extends BlockBase {
  type: 'list';
  ordered: boolean;
  items: string[];
}
interface Table extends BlockBase {
  type: 'table';
  headers?: string[];
  rows: string[][];
}
interface Image extends BlockBase {
  type: 'image';
  mime: string;
  path?: string;
  bytes: number;
  alt?: string;
  text?: string; // populated when a custom image parser is registered
}
```

Notes:

- **Paragraph `text` is inline markdown.** Bold, italic, code, and links are baked in as GFM syntax — you don't get separate "run" objects to walk.
- **List items are strings.** Same rule: inline markdown baked in. Nested lists are flattened.
- **Tables fan out merged cells.** If a `.xlsx` cell spans A1:B2 with the value `Total`, all four positions in `rows` will contain `Total`. Retrieval over rows never sees empty holes.
- **Images are metadata-only by default.** No bytes, no base64 — just MIME, path in the container, size, and (when available) alt text. Register a custom image parser (see below) and every embedded image gets a `text` field with the parser's output.
- **`sectionPath`** is the heading breadcrumb the block sits under, so an LLM can cite `Chapter 2 › Results` without you re-computing it.
- **`id`** is a deterministic SHA-1 of the block's content + position, so re-running extraction produces the same ids.

## Custom parsers

Zero-config `extract()` covers every supported format out of the box. When you want to override a MIME (e.g. run images through a vision LLM, or use your own PDF parser), use the `AnyExtractor` class and call `addParser()`:

```ts
import { AnyExtractor } from 'any-extractor';

const extractor = new AnyExtractor();

extractor.addParser({
  mimes: ['image/png', 'image/jpeg'],
  async parse(buffer, ctx) {
    const caption = await myVisionModel(buffer); // your call
    return {
      sections: [
        {
          kind: 'body',
          blocks: [ctx.block.paragraph(caption)],
          markdown: '',
        },
      ],
    };
  },
});

const result = await extractor.extract('./slides.pptx');
```

A few things happen automatically once that image parser is registered:

- Direct calls like `extractor.extract('./photo.png')` route to your parser.
- **Embedded images inside Word, PowerPoint, and OpenDocument files are enriched.** Every image block gets a `text` field with your parser's output, and its markdown rendering picks up a blockquote caption:

  ```markdown
  ![Sales chart](media/image1.png)

  > Bar chart showing Q3 revenue up 18% vs. Q2, driven by APAC.
  ```

- **User parsers win over built-ins.** Register a parser for `application/pdf` and it replaces the bundled PDF parser.
- **Image-parser errors are swallowed.** If your vision model throws, the image block is emitted without `text` — the rest of the document still comes through cleanly.
- **No recursion.** When your image parser runs, `ctx.parseImage(...)` is a no-op, so you can't accidentally build an infinite loop.

The `ctx` handed to your parser gives you the same building blocks the built-in parsers use:

```ts
interface ParserContext {
  block: BlockFactory; // ctx.block.heading, .paragraph, .list, .table, .image
  parseImage(bytes: Buffer, mime: string): Promise<string | undefined>;
}
```

## Errors

```ts
import { extract, AnyExtractor, UnsupportedFileTypeError } from 'any-extractor';

try {
  await extract('./mystery.bin');
} catch (err) {
  if (err instanceof UnsupportedFileTypeError) {
    console.log(err.mime); // the sniffed MIME that had no parser
  }
}
```

`UnsupportedFileTypeError` is thrown when no built-in or user-registered parser matches the sniffed MIME. Add a matching parser via `new AnyExtractor().addParser({ mimes: [...], parse })` to handle it.

## Why this scope

This package is aimed at feeding documents into agents, RAG pipelines, and LLM workflows. That means:

- **One entry point for the 90% case.** `extract(input)` — no factories, no builders, no options that only three people ever need.
- **One escape hatch for the last 10%.** `new AnyExtractor().addParser(...)` when you want to swap in a vision LLM, a stricter PDF backend, or your own MIME.
- **Markdown first.** LLMs are already trained on it; every block can be re-rendered without a separate template.
- **Provenance built in.** `page`, `sectionPath`, and `id` on every block, so citations and dedup are trivial.
- **Deterministic output.** Same file in → same ids out, so you can cache/upsert without churn.

If you need lower-level control (streaming, footnote extraction, styling metadata), this isn't the library — reach for `pdf.js`, `mammoth`, or `unoconv` directly.

## License

[MIT](./LICENSE)
