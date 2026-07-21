# any-extractor

> One `extract()` call. Any document. Agent-ready markdown + typed blocks + metadata.

[![npm version](https://img.shields.io/npm/v/any-extractor.svg)](https://www.npmjs.com/package/any-extractor)
[![license](https://img.shields.io/npm/l/any-extractor.svg)](./LICENSE)

`any-extractor` turns whatever file you point it at into three things:

1. **`markdown`** — a single GFM string, ready to hand to an LLM.
2. **`sections`** — ordered pages / slides / sheets / body sections, each with typed blocks _and_ their own markdown.
3. **`metadata`** — MIME type, title, author, page/slide counts, sheet names.

No streaming APIs. No chunking. No plugin system. No footguns. It parses the file and gives you clean, structured output.

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
}
```

Notes:

- **Paragraph `text` is inline markdown.** Bold, italic, code, and links are baked in as GFM syntax — you don't get separate "run" objects to walk.
- **List items are strings.** Same rule: inline markdown baked in. Nested lists are flattened.
- **Tables fan out merged cells.** If a `.xlsx` cell spans A1:B2 with the value `Total`, all four positions in `rows` will contain `Total`. Retrieval over rows never sees empty holes.
- **Images are metadata-only.** No bytes, no base64 — just MIME, path in the container, size, and (when available) alt text.
- **`sectionPath`** is the heading breadcrumb the block sits under, so an LLM can cite `Chapter 2 › Results` without you re-computing it.
- **`id`** is a deterministic SHA-1 of the block's content + position, so re-running extraction produces the same ids.

## Errors

```ts
import { extract, UnsupportedFileTypeError } from 'any-extractor';

try {
  await extract('./mystery.bin');
} catch (err) {
  if (err instanceof UnsupportedFileTypeError) {
    console.log(err.mime); // the sniffed MIME that had no parser
  }
}
```

## Why this scope

This package is aimed at feeding documents into agents, RAG pipelines, and LLM workflows. That means:

- **One entry point.** `extract(input)` — no factories, no builders, no options that only three people ever need.
- **Markdown first.** LLMs are already trained on it; every block can be re-rendered without a separate template.
- **Provenance built in.** `page`, `sectionPath`, and `id` on every block, so citations and dedup are trivial.
- **Deterministic output.** Same file in → same ids out, so you can cache/upsert without churn.

If you need low-level control (streaming, custom parsers, footnote extraction, styling metadata), this isn't the library — reach for `pdf.js`, `mammoth`, or `unoconv` directly.

## License

[MIT](./LICENSE)
