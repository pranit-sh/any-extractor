# any-extractor

[![NPM Version](https://img.shields.io/npm/v/any-extractor)](https://www.npmjs.com/package/any-extractor)
[![License](https://img.shields.io/npm/l/any-extractor)](https://www.npmjs.com/package/any-extractor)
[![Downloads](https://img.shields.io/npm/dm/any-extractor)](https://www.npmjs.com/package/any-extractor)

A tiny, dependency-light text extractor for Node.js. One function, many file types.

```ts
import { extractText } from 'any-extractor';

const text = await extractText('./resume.pdf');
console.log(text);
```

## Install

```bash
npm install any-extractor
```

Requires Node.js **18+**.

## Supported formats

| Format                                | MIME type                                                                   |
| ------------------------------------- | --------------------------------------------------------------------------- |
| PDF (`.pdf`)                          | `application/pdf`                                                           |
| Word (`.docx`)                        | `application/vnd.openxmlformats-officedocument.wordprocessingml.document`   |
| Excel (`.xlsx`)                       | `application/vnd.openxmlformats-officedocument.spreadsheetml.sheet`         |
| PowerPoint (`.pptx`)                  | `application/vnd.openxmlformats-officedocument.presentationml.presentation` |
| OpenDocument (`.odt`, `.ods`, `.odp`) | `application/vnd.oasis.opendocument.*`                                      |
| Plain text (`.txt`, `.md`, `.csv`, …) | `text/plain`                                                                |
| JSON (`.json`)                        | `application/json`                                                          |

Unrecognized binary files throw `UnsupportedFileTypeError` — no silent failures.

## Usage

### From a file path

```ts
import { extractText } from 'any-extractor';

const text = await extractText('./report.docx');
```

### From a Buffer

```ts
import { readFile } from 'node:fs/promises';
import { extractText } from 'any-extractor';

const buffer = await readFile('./slides.pptx');
const text = await extractText(buffer);
```

### From an HTTP(S) URL

```ts
const text = await extractText('https://example.com/spec.pdf');
```

### Structured output (pages, slides, sheets, metadata)

When you need provenance — e.g. for RAG, citation, or search indexing — use `extract` instead of `extractText`. You get ordered sections plus file-level metadata:

```ts
import { extract } from 'any-extractor';

const { text, sections, metadata } = await extract('./deck.pptx');

console.log(metadata.title, metadata.slideCount);
for (const s of sections) {
  console.log(`[${s.label ?? s.kind}]`, s.text);
  s.images?.forEach((img) => console.log('  image:', img.mime, img.bytes));
}
```

Each section carries `kind` (`body`, `page`, `slide`, `sheet`, `notes`, `footnote`, `endnote`), an optional `label` and 1-based `index`, and any images encountered while parsing it. `result.text` is the same string you'd get from `extractText` — so you can adopt the structured API without losing the simple case.

Metadata surfaces best-effort values across formats: `title`, `author`, `subject`, `keywords`, `language`, `createdAt`, `modifiedAt`, plus format-specific counters like `pageCount` (PDF), `slideCount` (PPTX/ODP) and `sheetNames` (XLSX).

### Authenticated URLs

Pass either a fully-formed header string or `{ user, password }` and it will be base64-encoded for you:

```ts
await extractText('https://example.com/private.docx', {
  auth: { user: 'alice', password: process.env.PASSWORD! },
});

// or, if you already have a header value:
await extractText(url, { auth: 'Bearer eyJhbGc…' });
```

## Handling embedded images

`any-extractor` does **not** ship any OCR or vision model. Embedded images in Word / Excel / PowerPoint files are surfaced as `ExtractedImage` entries on their section (with `mime`, `path`, `bytes`) — but the pixels are not decoded.

If you want a text description for each image, provide an `onImage` callback. You are responsible for the OCR / vision call — use whatever tool you like (Tesseract, a cloud OCR API, a multimodal LLM, …). The returned string is stored on `image.description`; consumers decide how to use it.

```ts
import { createExtractor } from 'any-extractor';
import { recognize } from 'tesseract.js'; // or any other OCR / vision API

const extractor = createExtractor({
  onImage: async (buffer, mime) => {
    const { data } = await recognize(buffer, 'eng');
    return data.text;
  },
});

const { sections } = await extractor.extract('./deck.pptx');
for (const s of sections) {
  s.images?.forEach((img) => console.log(img.path, img.description));
}
```

Return an empty string from `onImage` to skip a specific image.

## Custom parsers

You can register a parser for any MIME type — great for internal formats or overriding a built-in.

```ts
import { createExtractor, type FileParser, type ParserResult } from 'any-extractor';

class SqlParser implements FileParser {
  readonly mimes = ['application/sql', 'application/hdb'] as const;

  async parse(buffer: Buffer): Promise<ParserResult> {
    return { sections: [{ kind: 'body', text: buffer.toString('utf-8') }] };
  }
}

const extractor = createExtractor().addParser(new SqlParser());
const { text } = await extractor.extract('./schema.sql');
```

Registering a parser for a MIME type that's already handled **overrides** the built-in.

## API

### `extractText(input, options?)`

Extract plain text from a file path, HTTP(S) URL, or Buffer.

- `input`: `string | Buffer`
- `options.auth?`: `string | { user, password }` — used only when `input` is a URL.
- **Returns**: `Promise<string>`
- **Throws**: `UnsupportedFileTypeError` if the file's MIME type has no parser.

### `extract(input, options?)`

Extract structured text and metadata. Same inputs as `extractText`, but returns:

```ts
interface ExtractResult {
  text: string; // concatenation of all section texts
  sections: Section[]; // ordered, format-agnostic chunks
  metadata: ExtractMetadata; // title, author, page/slide/sheet counts, …
}

interface Section {
  kind: 'body' | 'page' | 'slide' | 'notes' | 'sheet' | 'footnote' | 'endnote';
  label?: string; // e.g. "Page 3", "Slide 2", "Sheet: Q1"
  index?: number; // 1-based within its kind
  text: string;
  images?: ExtractedImage[]; // images found while parsing this section
}
```

- **Returns**: `Promise<ExtractResult>`
- **Throws**: `UnsupportedFileTypeError` if the file's MIME type has no parser.

### `createExtractor(config?)`

Returns a reusable `AnyExtractor` with all built-in parsers registered.

- `config.onImage?`: `(buffer, mime) => Promise<string> | string` — hook invoked for every embedded image inside Office documents. Return the text to store on `image.description`, or `""` to skip. `any-extractor` does not do OCR itself.

### `class AnyExtractor`

Low-level extractor with an empty parser registry. Use this if you want full control:

```ts
const extractor = new AnyExtractor(config).addParser(new PDFParser());
const { text, sections, metadata } = await extractor.extract(buffer);
```

## License

[MIT](https://github.com/pranit-sh/any-extractor/blob/main/LICENSE)

## Issues & discussion

Found a bug or want a new format supported? [Open an issue](https://github.com/pranit-sh/any-extractor/issues) or [start a discussion](https://github.com/pranit-sh/any-extractor/discussions).

## Support

[![Buy Me a Coffee](https://img.shields.io/badge/Buy%20me%20a%20coffee-BD5FFF?style=flat&logo=buy-me-a-coffee&logoColor=ffffff&labelColor=BD5FFF)](https://www.buymeacoffee.com/pranit.sh)
