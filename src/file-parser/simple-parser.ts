import { AnyParserMethod } from '../types';

export class SimpleParser implements AnyParserMethod {
  mimes = ['text/plain', 'application/json'];

  apply = async (file: Buffer): Promise<string> => {
    return file.toString('utf-8');
  };
}
