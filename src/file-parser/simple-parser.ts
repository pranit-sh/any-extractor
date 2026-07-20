import type { FileParser } from '../types';

/**
 * Parser for plain-text-ish formats where the raw bytes are already UTF-8 text
 * (e.g. `.txt`, `.json`).
 */
export class SimpleParser implements FileParser {
  readonly mimes = ['text/plain', 'application/json'] as const;

  async parse(file: Buffer): Promise<string> {
    return file.toString('utf-8');
  }
}
