# any-extractor

> One `extract()` call. Any document. Agent-ready markdown + typed blocks + metadata.

[![npm version](https://img.shields.io/npm/v/any-extractor.svg)](https://www.npmjs.com/package/any-extractor)
[![license](https://img.shields.io/npm/l/any-extractor.svg)](./LICENSE)
[![Downloads](https://img.shields.io/npm/dm/any-extractor)](https://www.npmjs.com/package/any-extractor)

`any-extractor` turns whatever file you point it at into four things:

1. **`markdown`** — a single GFM string, rendered lazily from the blocks below and ready to hand to an LLM.
2. **`text`** — plain reading-order text (no markdown syntax), also lazy. Useful for embeddings, search indices, TTS, or cheap token counts.
3. **`sections`** — ordered pages / slides / sheets / body sections, each with typed blocks. The single source of truth.
4. **`metadata`** — MIME type, title, author, page/slide counts, sheet names.

Input can be a file path, URL, or `Buffer`. MIME type is detected automatically. Custom parsers can be registered via `AnyExtractor.addParser()` to override built-ins or add new MIME handlers (see [Custom parsers](#custom-parsers)).

> **What's new in 3.0**
>
> - Full rewrite around a five-block model (`heading`, `paragraph`, `list`, `table`, `image`) with stable content-derived ids.
> - Blocks are the single source of truth; `result.markdown` and `result.text` render on demand (cached after first access) so the payload no longer carries duplicate copies of every paragraph. Use `toMarkdown(section)` / `toText(section)` for per-section rendering.
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
console.log(result.markdown.slice(0, 200)); // GFM
console.log(result.text.slice(0, 200)); // plain text, no markdown syntax

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
  /** Full document as GFM. Rendered on first access, cached thereafter. */
  readonly markdown: string;
  /** Full document as plain text — no markdown syntax. Lazy and cached. */
  readonly text: string;
  sections: Section[];
  metadata: ExtractMetadata;
}

interface Section {
  kind: 'body' | 'page' | 'slide' | 'sheet';
  label?: string; // e.g. "Page 3", "Slide 2", "Q1 Sales"
  index?: number; // 1-based within its kind
  blocks: Block[]; // structured content — the source of truth
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

`Section` does not carry a rendered markdown/text string — that would duplicate every paragraph in memory and on the wire. Render on demand:

```ts
import { extract, toMarkdown, toText } from 'any-extractor';

const result = await extract('./report.pdf');

// Full document, in either form (lazy, cached):
console.log(result.markdown);
console.log(result.text);

// Per section, only when you need it:
for (const section of result.sections) {
  console.log(toMarkdown(section));
  console.log(toText(section));
}
```

### Markdown vs. plain text

| Output            | What you get                                                          | Good for                                                   |
| ----------------- | --------------------------------------------------------------------- | ---------------------------------------------------------- |
| `result.markdown` | GFM: headings, lists, tables, blockquote captions, inline `**` / `*`. | LLM prompts, human review, anything that renders markdown. |
| `result.text`     | Reading-order text. Bullets, pipes, and inline syntax stripped.       | Embeddings, keyword search, TTS, cheap token counts.       |

Rules for the plain-text render (deterministic, no third-party dependencies):

- Headings appear as bare lines.
- Paragraphs and list items have inline markdown (`**bold**`, `*italic*`, `` `code` ``, `[label](url)`) stripped to their visible characters. Word-internal underscores (`snake_case`) are left alone.
- Lists are one item per line, no bullet or number.
- Tables become tab-separated rows (headers first, when present). Newlines inside cells are collapsed to spaces so each row stays on one line.
- Images render as their `alt` (or parser-supplied `text`) if any; empty images produce no output.
- Blocks are separated by a blank line; sections by two blank lines (no `---` divider).

## The block model

Five block types.

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
        },
      ],
    };
  },
});

const result = await extractor.extract('./slides.pptx');
```

Once a parser is registered:

- Direct calls like `extractor.extract('./photo.png')` route to your parser.
- **User parsers override built-ins** for the same MIME.
- **Embedded images inside Word, PowerPoint, and OpenDocument files are enriched.** Every image block gets a `text` field with your parser's output, and its markdown rendering picks up a blockquote caption:

  ```markdown
  ![Sales chart](media/image1.png)

  > Bar chart showing Q3 revenue up 18% vs. Q2, driven by APAC.
  ```

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

## MCP server

`any-extractor` also ships as a [Model Context Protocol](https://modelcontextprotocol.io) server, so agents in Claude Desktop, Cursor, VS Code, Continue, or any other MCP-capable client can extract documents directly — no glue code, no shell-outs.

### Configure your client

```json
{
  "mcpServers": {
    "any-extractor": {
      "command": "npx",
      "args": ["-y", "any-extractor-mcp"]
    }
  }
}
```

To let the server read local files on the host, set the environment variable:

```json
{
  "mcpServers": {
    "any-extractor": {
      "command": "npx",
      "args": ["-y", "any-extractor-mcp"],
      "env": { "ANY_EXTRACTOR_ALLOW_LOCAL": "1" }
    }
  }
}
```

Without that flag, only HTTP(S) URLs and inline base64 `data` are accepted — a guardrail so a remote agent can't casually read arbitrary paths off your machine.

### Tools

| Tool                          | When to use                                                                   |
| ----------------------------- | ----------------------------------------------------------------------------- |
| `extract_document`            | Default. Returns compact GFM markdown + metadata + section index.             |
| `extract_document_structured` | Returns the full typed sections/blocks tree — for agents that walk structure. |
| `extract_section`             | Returns one section by index. Cheap way to page through large PDFs.           |

All three accept the same input shape:

```jsonc
{
  "url": "https://example.com/report.pdf", // or
  "path": "/abs/path/to/file.docx", // (requires ANY_EXTRACTOR_ALLOW_LOCAL=1)
  "data": "<base64>", // inline bytes
  "maxChars": 50000, // optional output cap
}
```

Errors (unsupported MIME, missing file, disabled local access) are returned as MCP tool errors, not thrown.

## Support

If `any-extractor` saved you an afternoon, you can [![Buy Me a Coffee](https://img.shields.io/badge/Buy%20me%20a%20coffee-BD5FFF?style=flat&logo=buy-me-a-coffee&logoColor=ffffff&labelColor=BD5FFF)](https://www.buymeacoffee.com/pranit.sh) — it keeps the parsers fed.

## License

[MIT](./LICENSE)
