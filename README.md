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
  blocks: Block[];
  markdown: string; // pre-rendered markdown for this section
};

type Block =
  | HeadingBlock // { level: 1–6, runs }
  | ParagraphBlock // { runs }
  | ListBlock // { ordered, items: ListItem[] }
  | TableBlock // { headers?, rows, raw? }
  | CodeBlock // { language?, text }
  | QuoteBlock // { blocks }
  | ImageBlock // { alt?, src?, mime?, data? }
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

## API

### `extract(input, options?) → Promise<ExtractResult>`

Extracts structured blocks, markdown, and metadata from a file path, URL, or
`Buffer`. The `options` object currently only carries `auth` for HTTP(S)
inputs (`auth: 'Basic ...'` or `auth: { user, password }`).

### `createExtractor() → AnyExtractor`

Build a reusable extractor with all built-in parsers registered. Chain
`.addParser(...)` to plug in your own.

```ts
import { createExtractor, type FileParser } from 'any-extractor';

const extractor = createExtractor().addParser(myCustomParser);

const result = await extractor.extract('./thing.foo');
```

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
