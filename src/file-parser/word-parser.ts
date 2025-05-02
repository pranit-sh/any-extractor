import { ERRORMSG } from '../constant';
import { AnyExtractor } from '../extractors/any-extractor';
import { AnyParserMethod, ExtractingOptions, ExtractedFile } from '../types';
import { extractFiles, parseString } from '../util';

export class WordParser implements AnyParserMethod {
  private anyExtractor: AnyExtractor;
  constructor(anyExtractor: AnyExtractor) {
    this.anyExtractor = anyExtractor;
  }

  mimes = ['application/vnd.openxmlformats-officedocument.wordprocessingml.document'];

  async apply(file: Buffer, extractingOptions: ExtractingOptions): Promise<string> {
    const mainRegex = /word\/document[\d+]?.xml/;
    const footnotesRegex = /word\/footnotes[\d+]?.xml/;
    const endnotesRegex = /word\/endnotes[\d+]?.xml/;
    const mediaRegex = /^word\/media\//;
    const relsRegex = /^word\/_rels\/document.xml.rels$/;

    try {
      const files = await extractFiles(
        file,
        (filePath) =>
          [mainRegex, footnotesRegex, endnotesRegex, relsRegex].some((r) => r.test(filePath)) ||
          mediaRegex.test(filePath),
      );

      const getFile = (regex: RegExp) => files.find((f) => regex.test(f.path));

      const mainDoc = getFile(mainRegex);
      const footnotesDoc = getFile(footnotesRegex);
      const endnotesDoc = getFile(endnotesRegex);
      const relsFile = getFile(relsRegex);

      if (!mainDoc || !relsFile) {
        throw ERRORMSG.fileCorrupted('Main content or relationships file is missing.');
      }

      const mediaFiles: Record<string, ExtractedFile> = {};
      for (const file of files) {
        if (mediaRegex.test(file.path)) {
          const fileName = file.path.split('/').pop()!;
          mediaFiles[fileName] = file;
        }
      }

      const embedMap = this.parseRelationships(relsFile.content.toString());

      const mainText = await this.extractTextAndImages(
        mainDoc.content.toString(),
        embedMap,
        mediaFiles,
        extractingOptions,
      );
      const footnotesText = footnotesDoc
        ? await this.extractTextAndImages(
            footnotesDoc.content.toString(),
            embedMap,
            mediaFiles,
            extractingOptions,
          )
        : '';
      const endnotesText = endnotesDoc
        ? await this.extractTextAndImages(
            endnotesDoc.content.toString(),
            embedMap,
            mediaFiles,
            extractingOptions,
          )
        : '';

      return [
        mainText,
        footnotesText ? '\n--- Footnotes ---\n' + footnotesText : '',
        endnotesText ? '\n--- Endnotes ---\n' + endnotesText : '',
      ].join('\n');
    } catch (error) {
      console.error('AnyExtractor: Error parsing Word file:', error);
      throw error;
    }
  }

  private parseRelationships(xmlContent: string): Record<string, string> {
    const doc = parseString(xmlContent);
    const rels = doc.getElementsByTagName('Relationship');

    const map: Record<string, string> = {};
    for (const rel of Array.from(rels)) {
      const id = rel.getAttribute('Id');
      const target = rel.getAttribute('Target');
      if (id && target?.startsWith('media/')) {
        const filename = target.split('/').pop()!;
        map[id] = filename;
      }
    }
    return map;
  }

  private async extractTextAndImages(
    xmlContent: string,
    embedMap: Record<string, string>,
    mediaFiles: Record<string, ExtractedFile>,
    extractingOptions: ExtractingOptions,
  ): Promise<string> {
    const doc = parseString(xmlContent);
    const paragraphs = Array.from(doc.getElementsByTagName('w:p'));

    const parts: string[] = [];

    for (const paragraph of paragraphs) {
      let paragraphText = '';

      // Extract text nodes
      const texts = Array.from(paragraph.getElementsByTagName('w:t'));
      paragraphText += texts.map((t) => t.childNodes[0]?.nodeValue || '').join('');

      // Extract drawings/images
      const drawings = Array.from(paragraph.getElementsByTagName('w:drawing'));
      for (const drawing of drawings) {
        const blip = drawing.getElementsByTagName('a:blip')[0];
        const embedId = blip?.getAttribute('r:embed');

        if (embedId && embedMap[embedId]) {
          const imageFile = mediaFiles[embedMap[embedId]];
          if (imageFile) {
            const imageBuffer = imageFile.content;
            const imageDescription = await this.convertImageToText(imageBuffer, extractingOptions);
            paragraphText += `\n[Image: ${imageDescription}]`;
          }
        }
      }

      if (paragraphText.trim()) {
        parts.push(paragraphText.trim());
      }
    }

    return parts.join('\n');
  }

  private async convertImageToText(
    imageBuffer: Buffer,
    extractingOptions: ExtractingOptions,
  ): Promise<string> {
    return await this.anyExtractor.parseFile(imageBuffer, null, extractingOptions);
  }
}
