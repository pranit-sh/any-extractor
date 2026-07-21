# Test fixtures

Sample files consumed by the vitest suite. Regenerate any of the binary
fixtures with a real Office / Word / PDF app if they get out of date — the
tests assert on the content described below.

## `sample.txt`

Three plain-text paragraphs separated by blank lines.

## `sample.md`

- H1 **Sample Document**
- A paragraph with **bold** and _italic_
- `## Features` + unordered list
- `## Ordered` + ordered list

## `sample.html`

Full HTML document with `<h1>`, `<p>`, `<h2>`, `<p>`, `<ul>`, plus a
`<style>` and `<script>` block that the parser must strip.

## `sample.csv`

Headers `name,age,city` with three rows, one of which contains a quoted
value with a comma (`"Manchester, UK"`).

## `sample.json`

```json
{
  "name": "any-extractor",
  "count": 3,
  "tags": ["docs", "extractor", "markdown"]
}
```

## `sample.docx` — Word

- Heading 1: **Quarterly Report**
- Paragraph: `This quarter **exceeded** expectations.` (bold on "exceeded")
- Heading 2: **Findings**
- Paragraph: `Revenue is up 18% year over year.`
- File properties: an **author** is set (any non-empty string is fine).

## `sample.xlsx` — Excel (two sheets)

**Sheet `Q1`**

| Region | Revenue |
| ------ | ------- |
| APAC   | 120     |
| EMEA   | 95      |

**Sheet `Q2`**

| Region | Revenue |
| ------ | ------- |
| North  | 140     |
| South  | 110     |

## `sample.pptx` — PowerPoint (two slides)

1. Title `Intro`, body `Welcome to the deck.`
2. Title `Results`, body `Revenue is up 18%.`

## `sample.pdf` — PDF (single page)

One line of text:

```
Hello from any-extractor PDF fixture.
```
