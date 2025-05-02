import Tesseract from 'tesseract.js';
import { AnyParserMethod, ExtractingOptions, ExtractorConfig } from '../types';
import { fetch } from 'undici';
import { parse } from 'file-type-mime';

export class ImageParser implements AnyParserMethod {
  mimes = ['image/jpeg', 'image/png', 'image/webp'];

  public apply = async (
    file: Buffer,
    extractingOptions: ExtractingOptions,
    extractorConfig: ExtractorConfig,
  ): Promise<string> => {
    const { extractImages, imageExtractionMethod, language } = extractingOptions;
    if (!extractImages) {
      return '';
    }
    const mimeDetails = parse(
      file.buffer.slice(file.byteOffset, file.byteOffset + file.byteLength) as ArrayBuffer,
    );
    if (!mimeDetails) {
      throw new Error('AnyExtractor: Unable to parse MIME type');
    }
    const mimeType = mimeDetails.mime;
    if (!this.mimes.includes(mimeType)) {
      return '';
    }
    if (imageExtractionMethod === 'ocr') {
      return await this.performOCR(file, language);
    }

    const { llmProvider, visionModel, apikey } = extractorConfig.llm || {};
    if (!llmProvider || !visionModel || !apikey) {
      throw new Error(
        'AnyExtractor: LLM provider, vision model and API key are required for image extraction',
      );
    }

    const base64Image = file.toString('base64');
    switch (llmProvider) {
      case 'openai':
        return this.handleOpenAI(base64Image, mimeType, visionModel, apikey);
      case 'google':
        return this.handleGoogle(base64Image, mimeType, visionModel, apikey);
      case 'anthropic':
        return this.handleAnthropic(base64Image, mimeType, visionModel, apikey);
      default:
        throw new Error(`ImageParser: Unsupported LLM provider '${llmProvider}'`);
    }
  };

  private performOCR = async (file: Buffer, language: string): Promise<string> => {
    const worker = await Tesseract.createWorker(language);
    const {
      data: { text },
    } = await worker.recognize(file);
    await worker.terminate();
    return text;
  };

  private handleOpenAI = async (
    base64Image: string,
    mimeType: string,
    visionModel: string,
    apikey: string,
  ): Promise<string> => {
    const response = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apikey}`,
      },
      body: JSON.stringify({
        model: visionModel,
        messages: [
          {
            role: 'user',
            content: [
              {
                type: 'text',
                text: 'Provide a concise summary of the image for semantic search. Exclude any introductions, labels, or formatting — just return the core content. Also include visible text and contextual details about layout, content type, or purpose.',
              },
              {
                type: 'image_url',
                image_url: {
                  url: `data:${mimeType};base64,${base64Image}`,
                },
              },
            ],
          },
        ],
      }),
    });

    if (!response.ok) {
      throw new Error(`ImageParser: OpenAI API error ${response.status}`);
    }

    const data = (await response.json()) as {
      choices: { message: { content: string } }[];
    };
    return data.choices[0].message.content;
  };

  private handleGoogle = async (
    base64Image: string,
    mimeType: string,
    visionModel: string,
    apikey: string,
  ): Promise<string> => {
    const response = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${visionModel}:generateContent?key=${apikey}`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          contents: [
            {
              parts: [
                {
                  text: 'Provide a concise summary of the image for semantic search. Exclude any introductions, labels, or formatting — just return the core content. Also include visible text and contextual details about layout, content type, or purpose.',
                },
                {
                  inlineData: {
                    mimeType: mimeType,
                    data: base64Image,
                  },
                },
              ],
            },
          ],
        }),
      },
    );

    if (!response.ok) {
      throw new Error(`Google Gemini error: ${response.statusText}`);
    }

    const data = (await response.json()) as {
      candidates: { content: { parts: { text: string }[] } }[];
    };
    return data.candidates[0].content.parts[0].text;
  };

  private handleAnthropic = async (
    base64Image: string,
    mimeType: string,
    visionModel: string,
    apikey: string,
  ): Promise<string> => {
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apikey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: visionModel,
        max_tokens: 300,
        messages: [
          {
            role: 'user',
            content: [
              {
                type: 'text',
                text: 'Provide a concise summary of the image for semantic search. Exclude any introductions, labels, or formatting — just return the core content. Also include visible text and contextual details about layout, content type, or purpose.',
              },
              {
                type: 'image',
                source: {
                  type: 'base64',
                  media_type: mimeType,
                  data: base64Image,
                },
              },
            ],
          },
        ],
      }),
    });

    if (!response.ok) {
      throw new Error(`Anthropic Claude error: ${response.statusText}`);
    }

    const data = (await response.json()) as { content: { text: string }[] };
    return data.content[0].text;
  };
}
