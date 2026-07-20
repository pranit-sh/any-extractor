import { extractText, getDocumentProxy, getMeta } from 'unpdf';
import type { FileParser, ParserResult, Section } from '../types';

/**
 * Parser for PDF files. Uses `unpdf` (a serverless build of PDF.js) which
 * works in Node.js, Deno, Bun, browsers and edge runtimes.
 *
 * Emits one {@link Section} per page (`kind: 'page'`) and surfaces document
 * info (title, author, timestamps, page count) as metadata.
 */
export class PDFParser implements FileParser {
  readonly mimes = ['application/pdf'] as const;

  async parse(file: Buffer): Promise<ParserResult> {
    const pdf = await getDocumentProxy(new Uint8Array(file));
    const [{ text: pages, totalPages }, meta] = await Promise.all([
      extractText(pdf, { mergePages: false }),
      getMeta(pdf).catch(() => undefined),
    ]);

    const sections: Section[] = pages.map((pageText, i) => ({
      kind: 'page',
      index: i + 1,
      label: `Page ${i + 1}`,
      text: pageText.trim(),
    }));

    const info = meta?.info ?? {};
    return {
      sections,
      metadata: {
        pageCount: totalPages,
        title: nonEmpty(info.Title),
        author: nonEmpty(info.Author),
        subject: nonEmpty(info.Subject),
        keywords: parseKeywords(info.Keywords),
        createdAt: toDate(info.CreationDate),
        modifiedAt: toDate(info.ModDate),
      },
    };
  }
}

function nonEmpty(v: unknown): string | undefined {
  return typeof v === 'string' && v.trim() ? v.trim() : undefined;
}

function parseKeywords(v: unknown): string[] | undefined {
  if (typeof v !== 'string' || !v.trim()) return undefined;
  return v
    .split(/[,;]/)
    .map((k) => k.trim())
    .filter(Boolean);
}

function toDate(v: unknown): Date | undefined {
  if (v instanceof Date) return v;
  if (typeof v !== 'string') return undefined;
  // PDF date format: D:YYYYMMDDHHmmSSOHH'mm'
  const m = v.match(/^D?:?(\d{4})(\d{2})?(\d{2})?(\d{2})?(\d{2})?(\d{2})?/);
  if (!m) {
    const d = new Date(v);
    return isNaN(d.getTime()) ? undefined : d;
  }
  const [, y, mo = '01', d = '01', h = '00', mi = '00', s = '00'] = m;
  const date = new Date(Date.UTC(+y, +mo - 1, +d, +h, +mi, +s));
  return isNaN(date.getTime()) ? undefined : date;
}
