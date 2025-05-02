# AnyExtractor

[![NPM Version](https://img.shields.io/npm/v/any-extractor)](https://www.npmjs.com/package/any-extractor)
[![License](https://img.shields.io/npm/l/any-extractor)](https://www.npmjs.com/package/any-extractor)
[![Downloads](https://img.shields.io/npm/dm/any-extractor)](https://www.npmjs.com/package/any-extractor)

A Node.js package to extract text from any file.

> This package is designed for **Node.js only** and does not work in browser environments.

## Table of Contents

- [Features](#features)
- [Supported Files](#supported-files)
- [Installation](#installation)
- [Getting Started](#getting-started)
- [Advanced Usage](#advanced-usage)
- [Custom Parsers](#custom-parsers)
- [Confluence Crawling](#confluence-crawling)
- [Needs Work](#needs-work)
- [Contributing](#contributing)
- [Credits](#credits)
- [License](#license)
- [Support](#support)

## Features

- **Multi-format file support:** Extracts text from a wide range of file types. (See below for list of supported files)
- **OCR for images:** Uses Optical Character Recognition to extract text from images within documents and standalone image files.
- **LLM for image description:** Leverages AI to extract images description, providing richer information.
- **ES6 and CommonJS support:** Supports both modern ES6 and traditional CommonJS JavaScript environments.
- **Flexible input options:** Supports local file path, buffers, and file URLs.
- **Auto type detection:** Automatically detects file type and extracts text using MIME type.
- **Customizable parsers:** Allows creating new or modifying existing document parsers for any MIME types.
- **Confluence support:** Extracts text from Confluence documents.

#### Supported Files

Here's a breakdown of the text extraction capabilities for each file type:

| File Type                                        | Text Extraction | Image Extraction |
| ------------------------------------------------ | --------------- | ---------------- |
| `.docx`                                          | ✅              | ✅               |
| `.pptx`                                          | ✅              | ✅               |
| `.xlsx`                                          | ✅              | ✅               |
| `.pdf`                                           | ✅              | ❌               |
| `.png`                                           | N/A             | ✅               |
| `.jpg`, `.jpeg`                                  | N/A             | ✅               |
| `.webp`                                          | N/A             | ✅               |
| `.odt`                                           | ✅              | ❌               |
| `.odp`                                           | ✅              | ❌               |
| `.ods`                                           | ✅              | ❌               |
| `.csv`                                           | ✅              | N/A              |
| `.txt`                                           | ✅              | N/A              |
| `.json`                                          | ✅              | N/A              |
| Plain text (e.g., `.py`,<br> `.ts`, `.md`, etc.) | ✅              | N/A              |
| `confluence`                                     | ✅              | ✅               |

## Installation

This is a Node.js module available through the npm registry.<br>
To work with this package, Node.js 20 or higher is required.

#### Package Manager

Using npm:

```bash
npm install any-extractor
```

## Getting Started

Here's a basic example of how to use AnyExtractor in both ES6 and CommonJS environments:

#### ES6 (using `import`):

```ts
import { getAnyExtractor } from 'any-extractor';

async function extractFromFile() {
  const anyExt = getAnyExtractor();
  const text = await anyExt.parseFile('./filename.docx');
  console.log('Extracted Text:', text);
}

extractFromFile();
```

#### CommonJS (using `require`):

```ts
const { getAnyExtractor } = require('any-extractor');

async function extractFromFile() {
  const textExt = getAnyExtractor();
  const result = await textExt.parseFile('./filename.docx');
  console.log(result);
}

extractFromFile();
```

## Advanced Usage

#### Parsing Images:

AnyExtractor provides two primary methods for extracting text from images.

1. Optical Character Recognition (OCR):<br>

   ```ts
   const anyExt = getAnyExtractor();

   const text = await anyExt.parseFile('./imgfile.png', null, {
     extractImages: true,
     imageExtractionMethod: 'ocr',
     language: 'eng',
   });

   console.log('Extracted Text:', text);
   ```

2. Using LLM:<br>

   ```ts
   const anyExt = getAnyExtractor({
     llmProvider: 'google',
     visionModel: 'gemini-2.0-flash',
     apikey: '<your-api-key>',
   });

   const text = await anyExt.parseFile('./imgfile.png', null, {
     extractImages: true,
     imageExtractionMethod: 'llm',
     language: 'eng',
   });

   console.log('Extracted Text:', text);
   ```

> Llm parsing supports `openai`, `google` and `anthropic` llmProvider for now. But you can always overwrite the image parser implementation with your code.

> Optional argument of methods `getAnyExtractor` and `parseFile` are required for the extractor to parse images. Otherwise it will return empty string.

> Image parsing also works other files, e.g., .docx, .pptx etc (see the table above).

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

  public apply = async (
    file: Buffer,
    mimeType: string,
    extractingOptions: ExtractingOptions,
    extractorConfig: ExtractorConfig,
  ): Promise<string> => {
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
    llm: {
      llmProvider: 'google',
      visionModel: 'gemini-2.0-flash',
      apikey: '<your-api-key>',
    },
    confluence: {
      baseUrl: '<baseurl>',
      email: '<username>',
      apiKey: '<api-key>',
    },
  });

  const result = await textExt.parseConfluenceDoc('<pageId>', {
    extractAttachments: true,
    extractImages: false,
    imageExtractionMethod: 'ocr',
    language: 'eng',
  });
}

crawlConfluence();
```

## Needs Work

1. `.pdf` and `OpenOffice` files doesn't support image extraction.
2. `.xlsx` parsing isn't well structured and ordered.
3. Doesn't support text extraction from web and compressed files.

## Changelog

This project uses [semantic-release](https://github.com/semantic-release/semantic-release) for automated versioning and changelog generation. See the [Releases](https://github.com/pranit-sh/any-extractor/releases) section for details.

## Contributing

Contributions are welcome! Please follow the [Conventional Commits](https://www.conventionalcommits.org/) style when committing changes.

1. Fork the repository
2. Create your feature branch (`git checkout -b feat/my-feature`)
3. Commit your changes
4. Push to the branch
5. Open a Pull Request

> Pre-commit hooks will run linting and formatting checks automatically.

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
