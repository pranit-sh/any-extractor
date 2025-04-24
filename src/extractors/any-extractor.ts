import { parse } from 'file-type-mime';
import {
  AnyParserMethod,
  ExtractingOptions,
  ExtractorConfig,
  SupportedOCRLanguage,
} from '../types';
import { isValidUrl, readFile, readFileUrl } from '../util';

export class AnyExtractor {
  private extractorConfig: ExtractorConfig = {
    llmProvider: 'openai',
    visionModel: '',
    apikey: '',
  };

  constructor(extractorConfig?: ExtractorConfig) {
    if (extractorConfig) {
      this.extractorConfig = extractorConfig;
    }
  }

  private mimeParserMap: Map<string, AnyParserMethod> = new Map();
  private parsers: AnyParserMethod[] = [];

  public addParser = (method: AnyParserMethod): this => {
    this.parsers.push(method);
    method.mimes.forEach((mime) => {
      this.mimeParserMap.set(mime, method);
    });
    return this;
  };

  public getRegisteredParsers = (): string[] => {
    return Array.from(this.mimeParserMap.keys());
  };

  public extractText = async (
    input: string | Buffer,
    extractingOptions: ExtractingOptions,
  ): Promise<string> => {
    let preparedInput: Buffer;
    if (typeof input === 'string') {
      if (isValidUrl(input)) {
        preparedInput = await readFileUrl(input);
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
    console.log(`AnyExtractor: Detected MIME type: ${mimeDetails.mime}`);
    const extractor = this.mimeParserMap.get(mimeDetails.mime);

    if (!extractor?.apply) {
      const message = `AnyExtractor: No extraction method registered for MIME type '${mimeDetails.mime}'`;
      throw new Error(message);
    }

    return extractor.apply(
      preparedInput,
      mimeDetails.mime,
      extractingOptions,
      this.extractorConfig,
    );
  };
}
