import { extractText, getDocumentProxy, getMeta } from 'unpdf';
import { makeSection } from '../blocks';
import type { Block, FileParser, ParserContext, ParserResult, Section } from '../types';
import { splitKeywords } from './ooxml-utils';

/**
 * Parser for PDF files. Uses `unpdf` (serverless PDF.js).
 *
 * Emits one {@link Section} per page (`kind: 'page'`). Each page's text is
 * split into paragraph blocks on blank lines, so line-wrapped paragraphs
 * stay coherent for downstream chunkers.
 */
export class PDFParser implements FileParser {
  readonly mimes = ['application/pdf'] as const;

  async parse(file: Buffer, ctx: ParserContext): Promise<ParserResult> {
    const pdf = await getDocumentProxy(new Uint8Array(file));
    const [{ text: pages, totalPages }, meta] = await Promise.all([
      extractText(pdf, { mergePages: false }),
      getMeta(pdf).catch(() => undefined),
    ]);

    const sections: Section[] = pages.map((pageText, i) => {
      const page = i + 1;
      const blocks = paragraphize(pageText).map<Block>((chunk) =>
        ctx.block.paragraph(chunk, { page }),
      );
      return makeSection('page', blocks, { index: page, label: `Page ${page}` });
    });

    const info = meta?.info ?? {};
    return {
      sections,
      metadata: {
        pageCount: totalPages,
        title: nonEmpty(info.Title),
        author: nonEmpty(info.Author),
        subject: nonEmpty(info.Subject),
        keywords: splitKeywords(typeof info.Keywords === 'string' ? info.Keywords : undefined),
        createdAt: toDate(info.CreationDate),
        modifiedAt: toDate(info.ModDate),
      },
    };
  }
}

/**
 * Split a raw page string into paragraph-sized chunks. Blank lines start a
 * new paragraph; internal line breaks are joined with a space so wrapped
 * lines re-flow correctly.
 */
function paragraphize(raw: string): string[] {
  return raw
    .split(/\n\s*\n+/)
    .map((chunk) => chunk.replace(/\s*\n\s*/g, ' ').trim())
    .filter(Boolean);
}

function nonEmpty(v: unknown): string | undefined {
  return typeof v === 'string' && v.trim() ? v.trim() : undefined;
}

function toDate(v: unknown): Date | undefined {
  if (v instanceof Date) return v;
  if (typeof v !== 'string') return undefined;
  const m = v.match(/^D?:?(\d{4})(\d{2})?(\d{2})?(\d{2})?(\d{2})?(\d{2})?/);
  if (!m) {
    const d = new Date(v);
    return isNaN(d.getTime()) ? undefined : d;
  }
  const [, y, mo = '01', d = '01', h = '00', mi = '00', s = '00'] = m;
  const date = new Date(Date.UTC(+y, +mo - 1, +d, +h, +mi, +s));
  return isNaN(date.getTime()) ? undefined : date;
}
