import { parse } from 'file-type-mime';
import { AnyParserMethod, ExtractorConfig } from '../types';
import { isValidUrl, readFile, readFileUrl } from '../util';
import { ConfluenceCrawler } from '../crawler/confluence-crawler';

export class AnyExtractor {
  private extractorConfig: ExtractorConfig = {
    confluence: {
      baseUrl: '',
      email: '',
      apiKey: '',
    },
  };

  constructor(extractorConfig?: ExtractorConfig) {
    if (extractorConfig) {
      this.extractorConfig = extractorConfig;
    }
  }

  private mimeParserMap: Map<string, AnyParserMethod> = new Map();

  public addParser = (method: AnyParserMethod): this => {
    method.mimes.forEach((mime) => {
      this.mimeParserMap.set(mime, method);
    });
    return this;
  };

  public parseFile = async (
    input: string | Buffer,
    basicAuth: string | null = null,
  ): Promise<string> => {
    let preparedInput: Buffer;
    if (typeof input === 'string') {
      if (isValidUrl(input)) {
        preparedInput = await readFileUrl(input, basicAuth);
      } else {
        preparedInput = await readFile(input);
      }
    } else {
      preparedInput = input;
    }
    if (!preparedInput) {
      throw new Error('AnyExtractor: No input provided');
    }

    const mimeDetails = parse(
      preparedInput.buffer.slice(
        preparedInput.byteOffset,
        preparedInput.byteOffset + preparedInput.byteLength,
      ) as ArrayBuffer,
    );
    if (!mimeDetails) {
      return preparedInput.toString('utf-8');
    }
    const extractor = this.mimeParserMap.get(mimeDetails.mime);

    if (!extractor?.apply) {
      return '';
    }

    return await extractor.apply(preparedInput, this.extractorConfig);
  };

  public parseConfluenceDoc = async (pageId: string): Promise<string> => {
    const { baseUrl, email, apiKey } = this.extractorConfig.confluence || {};
    if (!baseUrl || !email || !apiKey) {
      throw new Error('AnyExtractor: Confluence base URL, email, and API key are required');
    }
    const confCrawler = new ConfluenceCrawler(baseUrl, email, apiKey);
    const content = await confCrawler.extractPageContent(pageId);
    let textContent = '';
    for (const item of content) {
      if (item.type === 'image') {
        const parsedFile = await this.parseFile(
          item.content,
          `Basic ${Buffer.from(`${email}:${apiKey}`).toString('base64')}`,
        );
        textContent += parsedFile ? `\n(Image): ${parsedFile}\n` : '';
      } else if (item.type === 'view-file') {
        const parsedFile = await this.parseFile(
          item.content,
          `Basic ${Buffer.from(`${email}:${apiKey}`).toString('base64')}`,
        );
        textContent += parsedFile ? `\n[Attachment]: ${parsedFile}\n` : '';
      } else if (
        [
          'h1',
          'h2',
          'h3',
          'h4',
          'h5',
          'h6',
          'p',
          'table',
          'li',
          'code',
          'info',
          'warning',
          'tip',
          'note',
          'panel',
          'expand',
          'adf-extension',
        ].includes(item.type)
      ) {
        textContent += `\n${item.content}\n`;
      } else if (item.type === 'text') {
        textContent += ` ${item.content}`;
      }
    }
    return textContent;
  };
}
