import { AnyExtractor } from '../extractors/any-extractor';
import { AnyParserMethod } from '../types';
import { extractFiles, parseString } from '../util';

export class PowerPointParser implements AnyParserMethod {
  private anyExtractor: AnyExtractor;

  constructor(anyExtractor: AnyExtractor) {
    this.anyExtractor = anyExtractor;
  }

  mimes = ['application/vnd.openxmlformats-officedocument.presentationml.presentation'];

  async apply(file: Buffer): Promise<string> {
    const fileMatchRegex =
      /ppt\/(notesSlides|slides)\/(notesSlide|slide)\d+\.xml|ppt\/media\/image\d+\..+|ppt\/slides\/_rels\/slide\d+\.xml.rels/i;
    const slideNumberRegex = /slide(\d+)\.xml/;
    const imageRegex = /^ppt\/media\/image\d+\..+$/i;

    try {
      const files = await extractFiles(file, (x) => fileMatchRegex.test(x));
      const imageBuffers: Record<string, Buffer> = {};
      const slideXmls: Record<number, string> = {};
      const relsFiles: Record<number, string> = {};

      for (const file of files) {
        if (imageRegex.test(file.path)) {
          imageBuffers[file.path] = file.content;
        } else if (/ppt\/slides\/slide\d+\.xml/.test(file.path)) {
          const match = file.path.match(slideNumberRegex);
          if (match) slideXmls[+match[1]] = file.content.toString();
        } else if (/ppt\/slides\/_rels\/slide\d+\.xml.rels/.test(file.path)) {
          const match = file.path.match(slideNumberRegex);
          if (match) relsFiles[+match[1]] = file.content.toString();
        }
      }

      const results: string[] = [];

      const sortedSlideNumbers = Object.keys(slideXmls)
        .map(Number)
        .sort((a, b) => a - b);

      for (const slideNumber of sortedSlideNumbers) {
        const xmlContent = slideXmls[slideNumber];
        const slideText = this.extractTextFromXml(xmlContent);
        if (slideText) results.push(slideText);

        const imagePaths = this.extractImagePathsFromRels(relsFiles[slideNumber]);
        for (const imagePath of imagePaths) {
          const imageFullPath = `ppt/${imagePath.replace(/^(\.\.\/)+/, '')}`;
          const imageBuffer = imageBuffers[imageFullPath];
          if (imageBuffer) {
            const imageDescription = await this.convertImageToText(imageBuffer);
            if (imageDescription) {
              results.push(`[Image]: ${imageDescription}`);
            }
          }
        }
      }

      return results.join('\n');
    } catch (error) {
      console.error('AnyExtractor: Error parsing PowerPoint file:', error);
      throw error;
    }
  }

  private extractTextFromXml(xml: string): string {
    const xmlParagraphNodesList = parseString(xml).getElementsByTagName('a:p');

    return Array.from(xmlParagraphNodesList)
      .filter((paragraphNode) => paragraphNode.getElementsByTagName('a:t').length > 0)
      .map((paragraphNode) => {
        const xmlTextNodeList = paragraphNode.getElementsByTagName('a:t');
        return Array.from(xmlTextNodeList)
          .map((textNode) => textNode.childNodes[0]?.nodeValue || '')
          .join('');
      })
      .join('\n');
  }

  private extractImagePathsFromRels(relsXml?: string): string[] {
    if (!relsXml) return [];

    const rels = parseString(relsXml).getElementsByTagName('Relationship');
    return Array.from(rels)
      .filter((rel) => rel.getAttribute('Type')?.includes('/image') && rel.getAttribute('Target'))
      .map((rel) => rel.getAttribute('Target')!);
  }

  private async convertImageToText(imageBuffer: Buffer): Promise<string> {
    return this.anyExtractor.parseFile(imageBuffer, null);
  }
}
