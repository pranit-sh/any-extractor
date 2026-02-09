# AnyExtractor

[![NPM Version](https://img.shields.io/npm/v/any-extractor)](https://www.npmjs.com/package/any-extractor)
[![License](https://img.shields.io/npm/l/any-extractor)](https://www.npmjs.com/package/any-extractor)
[![Downloads](https://img.shields.io/npm/dm/any-extractor)](https://www.npmjs.com/package/any-extractor)

A Node.js package to extract text from any file.

## Features

- **Flexible input options:** Supports local file path, buffers, and file URLs.
- **Auto type detection:** Automatically detects file type and extracts text using MIME type.
- **Customizable parsers:** Allows creating new or modifying existing document parsers for any MIME types.
- **Confluence support:** Extracts text from Confluence documents.

#### Supported Files

Here's a breakdown of the text extraction capabilities for each file type:

| File Type                                        | Text Extraction |
| ------------------------------------------------ | --------------- |
| `.docx`                                          | ✅              |
| `.pptx`                                          | ✅              |
| `.xlsx`                                          | ✅              |
| `.pdf`                                           | ✅              |
| `.odt`                                           | ✅              |
| `.odp`                                           | ✅              |
| `.ods`                                           | ✅              |
| `.csv`                                           | ✅              |
| `.txt`                                           | ✅              |
| `.json`                                          | ✅              |
| Plain text (e.g., `.py`,<br> `.ts`, `.md`, etc.) | ✅              |
| `confluence`                                     | ✅              |

## Installation

```bash
npm install any-extractor
```

## Getting Started

```ts
import { getAnyExtractor } from 'any-extractor';

async function extractFromFile() {
  const anyExt = getAnyExtractor();
  const text = await anyExt.parseFile('./filename.docx');
  console.log('Extracted Text:', text);
}

extractFromFile();
```

## Advanced Usage

#### Authorization Parameter

The second argument in `parseFile`, shown as `null`, is for Basic Authentication when accessing file URLs. Format: `Basic <base64-encoded-credentials>`

Example:

```ts
const authString = 'Basic ' + Buffer.from('user:password').toString('base64');
const text = await anyExt.parseFile('https://example.com/protected-file.docx', authString);
console.log('Extracted Text:', text);
```

#### Custom Parsers:

AnyExtractor is designed with extensibility in mind, allowing you to integrate your own custom document parsers for handling specific or less common file formats, or to implement tailored text extraction logic.<br>
To create custom parser, you will need to implement `AnyParserMethod` class with the following signature:

- `mimes: string[]`: class variable which has the list of mime types for your targeted files.
- `apply: (buffer, mime, options, config)`: class method which returns the extracted text as string.
  - buffer: file buffer
  - mime: mime type of the file
  - options?: second argument of extractText method
  - config?: argument of getAnyExtractor method

Create your extractor class implementing the `AnyParserMethod`.

```ts
import { AnyParserMethod } from 'any-extractor';

export class CustomParser implements AnyParserMethod {
  public mimes = ['application/hdb', 'application/sql'];

  public apply = async (file: Buffer, extractorConfig: ExtractorConfig): Promise<string> => {
    // your text extraction logic
  };
}
```

Add your custom parser to any extractor instance.

```ts
const anyExt = getAnyExtractor();
anyExt.addParser(new CustomParser());
const text = await anyExt.extractText('./filename.sql');
console.log('Extracted Text:', text);
```

> Creating custom parsers for existing mimetypes will overwrite the implementation.

#### Confluence Crawling

Extract text from Confluence documents:

```ts
const { getAnyExtractor } = require('any-extractor');

async function crawlConfluence() {
  const textExt = getAnyExtractor({
    confluence: {
      baseUrl: '<baseurl>',
      email: '<username>',
      apiKey: '<api-key>',
    },
  });

  const result = await textExt.parseConfluenceDoc('<pageId>');
}

crawlConfluence();
```

## Credits

**any-extractor** is inspired from [officeparser](https://www.npmjs.com/package/officeparser) and it uses [tesseract.js](https://www.npmjs.com/package/tesseract.js)<br>
Ultimately any-extractor is an effort to provide a universal standalone text extractor for every file.

## License

[MIT](https://github.com/pranit-sh/any-extractor/blob/main/LICENSE)

## Report

If you encounter bugs or have feature requests, [open an issue](https://github.com/pranit-sh/any-extractor/issues).
Feel free to [start a discussion](https://github.com/pranit-sh/any-extractor/discussions) — whether it’s feedback, a question, or an idea!

## Support

[![Buy Me a Coffee](https://img.shields.io/badge/Buy%20me%20a%20coffee-BD5FFF?style=flat&logo=buy-me-a-coffee&logoColor=ffffff&labelColor=BD5FFF)](https://www.buymeacoffee.com/pranit.sh)
