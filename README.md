# AnyExtractor

[![NPM Version](https://img.shields.io/npm/v/any-extractor)](https://www.npmjs.com/package/any-extractor)
[![License](https://img.shields.io/npm/l/any-extractor)](https://www.npmjs.com/package/any-extractor)
[![Downloads](https://img.shields.io/npm/dm/any-extractor)](https://www.npmjs.com/package/any-extractor)

A Node.js package to extract text from any file.

## Features
* **Multi-format file support:** Extracts text from a wide range of file types. (See below for list of supported files)
* **OCR for images:** Uses Optical Character Recognition to extract text from images within documents and standalone image files.
* **LLM for image description:** Leverages AI to extract descriptive text from images, providing richer information.
* **ES6 and CommonJS support:** Supports both modern ES6 and traditional CommonJS JavaScript environments.
* **Flexible input options:** Supports local file path, buffers, and file URLs.
* **Auto type detection:** Automatically detects file type and extracts text using MIME type.
* **Customizable parsers:** Allows creating new or modifying existing document parsers for any MIME types.

#### Supported Files

Here's a breakdown of the text extraction capabilities for each file type:

| File Type       | Text Extraction       | Image Extraction  |
| ----------     | -------------------- | ---------------  |
| `.docx`         | ✅                    | ✅                |
| `.pptx`         | ✅                    | ✅                |
| `.xlsx`         | ✅                    | ✅                |
| `.pdf`          | ✅                    | ❌                |
| `.png`          | N/A                   | ✅                |
| `.jpg`, `.jpeg` | N/A                   | ✅                |
| `.webp`         | N/A                   | ✅                |
| `.odt`          | ✅                   | ❌                |
| `.odp`          | ✅                   | ❌                |
| `.ods`          | ✅                   | ❌                |
| `.csv`          | ✅                   | N/A                |
| `.txt`          | ✅                   | N/A                |
| `.json`          | ✅                   | N/A                |
| Plain text (e.g., `.py`,<br> `.ts`, `.md`, etc.) | ✅          | N/A

## Installation

This is a Node.js module available through the npm registry.<br>
Before installing, download and install Node.js. Node.js 20 or higher is required.

#### Package Manager

Using npm:
```bash
npm install any-extractor
```

## Getting Started

Here's a basic example of how to use AnyExtractor in both ES6 and CommonJS environments:

#### ES6 (using `import`):

```ts
import { getAnyExtractor } from "any-extractor";

async function extractFromFile() {
  const anyExt = getAnyExtractor();
  const text = await anyExt.extractText("./filename.docx");
  console.log('Extracted Text:', text);
}

extractFromFile();
```

#### CommonJS (using `require`):

```ts
const { getAnyExtractor } = require("any-extractor");

async function extractFromFile() {
  const textExt = getAnyExtractor();
  const result = await textExt.extractText("./filename.docx");
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

    const text = await anyExt.extractText('./imgfile.png', {
      extractImages: true,
      imageExtractionMethod: 'ocr',
      language: 'eng'
    });

    console.log('Extracted Text:', text);
    ```

2. Using LLM:<br>
    ```ts
    const anyExt = getAnyExtractor({
      llmProvider: 'google',
      visionModel: 'gemini-2.0-flash',
      apikey: '<your-api-key>'
    });

    const text = await anyExt.extractText('./imgfile.png', {
      extractImages: true,
      imageExtractionMethod: 'llm',
      language: 'eng'
    });

    console.log('Extracted Text:', text);
    ```

> Optional argument of `getAnyExtractor` and `extractText` are required for the extractor to parse images. Otherwise it will return empty string.

> Image parsing also works other files, e.g., .docx, .pptx etc (see the table above).

#### Custom Parsers:

AnyExtractor is designed with extensibility in mind, allowing you to integrate your own custom document parsers for handling specific or less common file formats, or to implement tailored text extraction logic.<br>
To create custom parser, you will need to implement `AnyParserMethod` class with the following signature:

- `mimes: string[]`: class variable which has the list of mime types for your targeted files.
- `apply: (buffer, mime, options, config)`: class method which returns the extracted text as string.
    + buffer: file buffer
    + mime: mime type of the file
    + options?: second argument of extractText method
    + config?: argument of getAnyExtractor method

Create your extractor class implementing the `AnyParserMethod`.
```ts
export class CustomParser implements AnyParserMethod {
  public mimes = ['image/jpeg', 'image/png', 'image/webp'];

  public apply = async (
    file: Buffer,
    mimeType: string,
    extractingOptions: ExtractingOptions,
    extractorConfig: ExtractorConfig,
  ): Promise<string> => {
    // your text extraction logic
  }
}
```

Add your custom parser to any extractor instance.
```ts
const anyExt = getAnyExtractor();
anyExt.addParser(new CustomParser());
const text = await anyExt.extractText("./filename.webp");
console.log('Extracted Text:', text);
```

> Creating custom parsers for existing mimetypes will overwrite the implementation.

## Credits
any-extractor is heavily inspired from [officeparser](https://www.npmjs.com/package/officeparser). Ultimately any-extractor is an effort to provide a universal standalone text extractor for every file.

## License
[MIT](https://github.com/pranit-sh/any-extractor/blob/main/LICENSE)