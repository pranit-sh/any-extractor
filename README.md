# any-extractor

> One `extract()` call. Any document. Agent-ready markdown, typed blocks, and metadata.

[![npm version](https://img.shields.io/npm/v/any-extractor.svg)](https://www.npmjs.com/package/any-extractor)
[![license](https://img.shields.io/npm/l/any-extractor.svg)](./LICENSE)
[![Downloads](https://img.shields.io/npm/dm/any-extractor)](https://www.npmjs.com/package/any-extractor)
[![Issues](https://img.shields.io/github/issues/pranit-sh/any-extractor.svg)](https://github.com/pranit-sh/any-extractor/issues)

Point it at a file, URL, or Buffer. Get back:

- **`markdown`** — a single GFM string, ready for an LLM.
- **`text`** — plain reading-order text, ready for embeddings or search.
- **`sections`** — ordered pages / slides / sheets with typed blocks.
- **`metadata`** — MIME, title, author, page count, sheet names.

```ts
import { extract } from 'any-extractor';

const result = await extract('./quarterly-report.pdf');

result.markdown; // GFM string
result.text; // plain text
result.sections; // typed blocks
result.metadata; // { mime, title, pageCount, ... }
```

<details>
<summary>Response</summary>

**`result.markdown`**

```markdown
# Q3 Results

Revenue grew **18%** year-over-year, driven by APAC.

| Region | Revenue |
| ------ | ------- |
| APAC   | $4.2M   |
| EMEA   | $3.1M   |
```

**`result.sections`**

```ts
[
  {
    kind: 'page',
    label: 'Page 1',
    index: 1,
    blocks: [
      { id: 'a1b2…', type: 'heading', level: 1, text: 'Q3 Results' },
      {
        id: 'c3d4…',
        type: 'paragraph',
        text: 'Revenue grew **18%** year-over-year, driven by APAC.',
      },
      {
        id: 'e5f6…',
        type: 'table',
        headers: ['Region', 'Revenue'],
        rows: [
          ['APAC', '$4.2M'],
          ['EMEA', '$3.1M'],
        ],
      },
    ],
  },
];
```

**`result.metadata`**

```ts
{
  mime: 'application/pdf',
  source: './quarterly-report.pdf',
  title: 'Q3 Results',
  author: 'Finance Team',
  pageCount: 42,
}
```

</details>

---

## Install

```bash
npm install any-extractor
```

Node.js ≥ 18.

---

## MCP Server

`any-extractor` doubles as a [Model Context Protocol](https://modelcontextprotocol.io) server. Drop it into Claude Desktop, Cursor, VS Code, Continue, or any MCP-capable agent.

```jsonc
{
  "mcpServers": {
    "any-extractor": {
      "command": "npx",
      "args": ["-y", "any-extractor-mcp"],
    },
  },
}
```

| Tool                          | Use it for                                                    |
| ----------------------------- | ------------------------------------------------------------- |
| `extract_document`            | Default. Markdown + metadata + section index.                 |
| `extract_document_structured` | Full typed section/block tree — for agents that walk content. |
| `extract_section`             | One section by index. Cheap paging for large PDFs.            |

---

## Supported formats

| Format       | Sections emitted           |
| ------------ | -------------------------- |
| PDF          | one `page` per page        |
| Word         | single `body`              |
| Excel        | one `sheet` per worksheet  |
| PowerPoint   | one `slide` per slide      |
| OpenDocument | `body` / `sheet` / `slide` |
| HTML         | single `body`              |
| Markdown     | single `body`              |
| Plain text   | single `body`              |
| CSV          | single `body`              |
| JSON         | single `body`              |

---

## CLI

```bash
# Markdown to stdout (default)
npx any-extractor report.pdf

# Everything else — flags, formats, URLs, stdin, timeouts
npx any-extractor --help
```

---

## Programmatic API

### Cancellation & timeouts

```ts
// User-driven cancel
const ac = new AbortController();
await extract('./big.pdf', { signal: ac.signal });

// Hard deadline
await extract(url, { timeoutMs: 10_000 });

// Both — whichever fires first wins
await extract(url, { signal: ac.signal, timeoutMs: 30_000 });
```

### Custom parsers

Register your own MIME handler — e.g. route images through a vision LLM. User parsers override built-ins, and embedded images inside Word / PowerPoint / OpenDocument get enriched automatically.

```ts
import { AnyExtractor } from 'any-extractor';

const extractor = new AnyExtractor();

extractor.addParser({
  mimes: ['image/png', 'image/jpeg'],
  concurrency: 2, // rate-limit in-flight calls
  async parse(buffer, ctx) {
    const caption = await myVisionModel(buffer);
    return {
      sections: [{ kind: 'body', blocks: [ctx.block.paragraph(caption)] }],
    };
  },
});

await extractor.extract('./slides.pptx');
```

Enriched images render with a blockquote caption in the output markdown:

```markdown
![Sales chart](media/image1.png)

> Bar chart showing Q3 revenue up 18% vs. Q2, driven by APAC.
```

---

## Issues & feature requests

Found a bug or want a new feature? **[Open an issue on GitHub](https://github.com/pranit-sh/any-extractor/issues/new/choose)**.

## Support

If `any-extractor` saved you an afternoon, you can [![Buy Me a Coffee](https://img.shields.io/badge/Buy%20me%20a%20coffee-BD5FFF?style=flat&logo=buy-me-a-coffee&logoColor=ffffff&labelColor=BD5FFF)](https://www.buymeacoffee.com/pranit.sh) — it keeps the parsers fed.

## License

[MIT](./LICENSE)
