import { Element } from '@xmldom/xmldom';
import { ERRORMSG } from '../constant';
import { AnyParserMethod, ExtractingOptions } from '../types';
import { extractFiles, parseString } from '../util';
import { AnyExtractor } from '../extractors/any-extractor';

export class ExcelParser implements AnyParserMethod {
  mimes = ['application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'];

  private anyExtractor: AnyExtractor;
  constructor(anyExtractor: AnyExtractor) {
    this.anyExtractor = anyExtractor;
  }

  async apply(file: Buffer, _: string, extractingOptions: ExtractingOptions): Promise<string> {
    const patterns = {
      sheets: /xl\/worksheets\/sheet\d+.xml/g,
      drawings: /xl\/drawings\/drawing\d+.xml/g,
      charts: /xl\/charts\/chart\d+.xml/g,
      sharedStrings: 'xl/sharedStrings.xml',
      images: /xl\/media\/image\d+\.(png|jpeg|jpg|webp)/g,
    };

    try {
      const files = await extractFiles(
        file,
        (path) =>
          [patterns.sheets, patterns.drawings, patterns.charts, patterns.images].some((regex) =>
            regex.test(path),
          ) || path === patterns.sharedStrings,
      );

      if (files.length === 0 || !files.some((file) => patterns.sheets.test(file.path))) {
        throw ERRORMSG.fileCorrupted('Missing or corrupted sheet files.');
      }

      const xmlContent = {
        sheets: files
          .filter((file) => patterns.sheets.test(file.path))
          .map((file) => file.content.toString()),
        drawings: files
          .filter((file) => patterns.drawings.test(file.path))
          .map((file) => file.content.toString()),
        charts: files
          .filter((file) => patterns.charts.test(file.path))
          .map((file) => file.content.toString()),
        sharedStrings: files
          .find((file) => file.path === patterns.sharedStrings)
          ?.content.toString(),
        images: files.filter((file) => patterns.images.test(file.path)),
      };

      const sharedStrings = this.parseSharedStrings(xmlContent.sharedStrings);

      const orderedText = files
        .map(async (file) => {
          if (patterns.sheets.test(file.path)) {
            return this.extractSheetText([file.content.toString()], sharedStrings);
          } else if (patterns.drawings.test(file.path)) {
            return this.extractDrawingText([file.content.toString()]);
          } else if (patterns.charts.test(file.path)) {
            return this.extractChartText([file.content.toString()]);
          } else if (patterns.images.test(file.path)) {
            return await this.extractImageText([file], extractingOptions);
          }
          return null;
        })
        .filter(Boolean);

      const resolvedText = await Promise.all(orderedText);
      return resolvedText.filter(Boolean).join('\n');
    } catch (error) {
      console.error('AnyExtractor: Error parsing Excel file:', error);
      throw error;
    }
  }

  private parseSharedStrings(sharedStringsXml?: string): string[] {
    if (!sharedStringsXml) return [];
    const tNodes = parseString(sharedStringsXml).getElementsByTagName('t');
    return Array.from(tNodes).map((node) => node.childNodes[0]?.nodeValue ?? '');
  }

  private extractSheetText(sheetFiles: string[], sharedStrings: string[]): string {
    return sheetFiles
      .map((content) => {
        const cNodes = parseString(content).getElementsByTagName('c');
        return Array.from(cNodes)
          .filter((node) => this.isValidInlineString(node) || this.hasValidValueNode(node))
          .map((node) => this.getCellValue(node, sharedStrings))
          .join('\n');
      })
      .join('\n');
  }

  private extractDrawingText(drawingFiles: string[]): string {
    return drawingFiles
      .map((content) => {
        const pNodes = parseString(content).getElementsByTagName('a:p');
        return Array.from(pNodes)
          .map((node) => {
            const tNodes = node.getElementsByTagName('a:t');
            return Array.from(tNodes)
              .map((tNode) => tNode.childNodes[0]?.nodeValue ?? '')
              .join('');
          })
          .join('\n');
      })
      .join('\n');
  }

  private extractChartText(chartFiles: string[]): string {
    return chartFiles
      .map((content) => {
        const vNodes = parseString(content).getElementsByTagName('c:v');
        return Array.from(vNodes)
          .map((node) => node.childNodes[0]?.nodeValue ?? '')
          .join('\n');
      })
      .join('\n');
  }

  private async extractImageText(
    imageFiles: { path: string; content: Buffer }[],
    extractingOptions: ExtractingOptions,
  ): Promise<string> {
    const texts = await Promise.all(
      imageFiles.map(async (file) => {
        try {
          return await this.anyExtractor.extractText(file.content, extractingOptions);
        } catch (e) {
          console.log(`AnyExtractor: Error extracting text from image ${file.path}:`, e);
          return '';
        }
      }),
    );
    return texts.filter(Boolean).join('\n');
  }

  private isValidInlineString(cNode: Element): boolean {
    if (cNode.tagName.toLowerCase() !== 'c' || cNode.getAttribute('t') !== 'inlineStr')
      return false;
    const isNodes = cNode.getElementsByTagName('is');
    const tNodes = isNodes[0]?.getElementsByTagName('t');
    return tNodes?.[0]?.childNodes[0]?.nodeValue !== undefined;
  }

  private hasValidValueNode(cNode: Element): boolean {
    const vNodes = cNode.getElementsByTagName('v');
    return vNodes[0]?.childNodes[0]?.nodeValue !== undefined;
  }

  private getCellValue(cNode: Element, sharedStrings: string[]): string {
    if (this.isValidInlineString(cNode)) {
      return (
        cNode.getElementsByTagName('is')[0].getElementsByTagName('t')[0].childNodes[0].nodeValue ??
        ''
      );
    }

    if (this.hasValidValueNode(cNode)) {
      const isSharedString = cNode.getAttribute('t') === 's';
      const valueIndex = parseInt(
        cNode.getElementsByTagName('v')[0].childNodes[0].nodeValue ?? '',
        10,
      );

      if (isSharedString) {
        if (valueIndex >= sharedStrings.length) {
          throw ERRORMSG.fileCorrupted('AnyExtractor: Invalid shared string index.');
        }
        return sharedStrings[valueIndex];
      }

      return valueIndex.toString();
    }

    return '';
  }
}
