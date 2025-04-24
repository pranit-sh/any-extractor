import pdf from 'pdf-parse';
import { AnyParserMethod } from '../types';

export class PDFParser implements AnyParserMethod {
  mimes = ['application/pdf'];

  apply = async (file: Buffer): Promise<string> => {
    try {
      const data = await pdf(file);
      const textContent = data.text;
      return  textContent;
    } catch (error) {
      console.error('Error parsing PDF file:', error);
      throw error;
    }
  };
}
