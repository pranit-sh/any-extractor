import { describe, it, expect } from 'vitest';
import { getAnyExtractor } from '../src';
import path from 'path';

const dataFolderPath = path.join(__dirname, 'data');

describe('AnyExtractor Tests', () => {
  it('should extract text from a .docx file', async () => {
    const anyExt = getAnyExtractor();
    const docPath = path.join(dataFolderPath, '05-versions-space.docx');
    const text = await anyExt.parseFile(docPath);
    expect(text).toContain('Sample Text');
  });

  it('should extract text from a .xlsx file', async () => {
    const anyExt = getAnyExtractor();
    const docPath = path.join(dataFolderPath, '05-versions-space.xlsx');
    const text = await anyExt.parseFile(docPath);
    expect(text).toContain('Spreadsheet Data');
  });

  it('should extract text from a .pdf file', async () => {
    const anyExt = getAnyExtractor();
    const docPath = path.join(dataFolderPath, '05-versions-space.pdf');
    const text = await anyExt.parseFile(docPath);
    expect(text).toContain('Text from PDF');
  });

  it('should extract text from a .pptx file', async () => {
    const anyExt = getAnyExtractor();
    const docPath = path.join(dataFolderPath, '05-versions-space.pptx');
    const text = await anyExt.parseFile(docPath);
    expect(text).toContain('Slide Content');
  });

  it('should extract text from a .json file', async () => {
    const anyExt = getAnyExtractor();
    const docPath = path.join(dataFolderPath, '05-versions-space.json');
    const text = await anyExt.parseFile(docPath);
    expect(text).toContain('"name": "Sample"');
  });

  it('should extract text from a .odt file', async () => {
    const anyExt = getAnyExtractor();
    const docPath = path.join(dataFolderPath, '05-versions-space.odt');
    const text = await anyExt.parseFile(docPath);
    expect(text).toContain('Text from PDF');
  });

  it('should extract text from a document URL', async () => {
    const anyExt = getAnyExtractor();
    const text = await anyExt.parseFile(
      'https://www.w3.org/WAI/ER/tests/xhtml/testfiles/resources/pdf/dummy.pdf',
    );
    expect(text).toContain('Dummy PDF file');
  });

  it('should extract text from an image using OCR', async () => {
    const anyExt = getAnyExtractor();
    const docPath = path.join(dataFolderPath, '05-versions-space.png');
    const text = await anyExt.parseFile(docPath, null, {
      extractImages: true,
      imageExtractionMethod: 'ocr',
      language: 'eng',
    });
    expect(text).toContain('DSSD COMPUTER EDUCATION');
  });

  it('should extract text from a .docx file containing an image', async () => {
    const anyExt = getAnyExtractor();
    const docPath = path.join(dataFolderPath, '05-versions-space.docx');
    const text = await anyExt.parseFile(docPath, null, {
      extractImages: true,
      imageExtractionMethod: 'ocr',
      language: 'eng',
    });
    expect(text).toContain('Sample Text');
    expect(text).toContain('DSSD COMPUTER EDUCATION');
  });
});
