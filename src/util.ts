import yauzl from 'yauzl';
import { DOMParser } from '@xmldom/xmldom';
import type { ExtractedFile } from './types';

/** Fetch a URL and return the response body as a Buffer. */
export async function readFileUrl(url: string): Promise<Buffer> {
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`any-extractor: failed to fetch ${url} — ${res.status} ${res.statusText}`);
  }
  return Buffer.from(await res.arrayBuffer());
}

/** Return true if the given string parses as a valid absolute URL. */
export function isValidUrl(str: string): boolean {
  try {
    new URL(str);
    return true;
  } catch {
    return false;
  }
}

/** Parse an XML string into a document. */
export function parseXml(xml: string) {
  return new DOMParser().parseFromString(xml, 'text/xml');
}

/** Extract selected entries from a zip buffer or path. */
export function extractFiles(
  zipInput: Buffer | string,
  filterFn: (path: string) => boolean,
): Promise<ExtractedFile[]> {
  return new Promise((resolve, reject) => {
    const handle = (zipfile: yauzl.ZipFile) => {
      const out: ExtractedFile[] = [];
      zipfile.readEntry();
      zipfile.on('entry', (entry: yauzl.Entry) => {
        if (!filterFn(entry.fileName)) {
          zipfile.readEntry();
          return;
        }
        zipfile.openReadStream(entry, (err, stream) => {
          if (err) return reject(err);
          const chunks: Buffer[] = [];
          stream.on('data', (chunk: Buffer) => chunks.push(chunk));
          stream.on('end', () => {
            out.push({ path: entry.fileName, content: Buffer.concat(chunks) });
            zipfile.readEntry();
          });
          stream.on('error', reject);
        });
      });
      zipfile.on('end', () => resolve(out));
      zipfile.on('error', reject);
    };

    if (Buffer.isBuffer(zipInput)) {
      yauzl.fromBuffer(zipInput, { lazyEntries: true }, (err, zipfile) => {
        if (err) return reject(err);
        handle(zipfile);
      });
    } else {
      yauzl.open(zipInput, { lazyEntries: true }, (err, zipfile) => {
        if (err) return reject(err);
        handle(zipfile);
      });
    }
  });
}

/**
 * Peek inside a ZIP buffer and return a more specific MIME than
 * `application/zip` when the archive is actually an OOXML (Word / Excel /
 * PowerPoint) or ODF (Text / Spreadsheet / Presentation) document.
 *
 * We need this because `file-type-mime` sniffs only the outer ZIP local
 * header. Documents written with streaming ZIP writers — including files
 * exported by modern Excel / Word — set general-purpose bit 3, which
 * blanks out the size fields in the local header and prevents the
 * heuristic from finding `[Content_Types].xml`. The sniffer falls back
 * to `application/zip` and the extractor throws `UnsupportedFileTypeError`.
 *
 * Detection order:
 *   1. ODF: a top-level `mimetype` entry whose content starts with
 *      `application/vnd.oasis.opendocument.*`.
 *   2. OOXML: presence of a well-known part (`xl/workbook.xml`,
 *      `word/document.xml`, `ppt/presentation.xml`).
 *
 * Returns `undefined` if the archive is a plain ZIP we can't classify.
 */
export async function sniffZipMime(zip: Buffer): Promise<string | undefined> {
  const entryNames = new Set<string>();
  let odfMime: string | undefined;

  await new Promise<void>((resolve, reject) => {
    yauzl.fromBuffer(zip, { lazyEntries: true }, (err, zipfile) => {
      if (err) return reject(err);
      zipfile.readEntry();
      zipfile.on('entry', (entry: yauzl.Entry) => {
        entryNames.add(entry.fileName);
        if (entry.fileName === 'mimetype' && odfMime === undefined) {
          zipfile.openReadStream(entry, (streamErr, stream) => {
            if (streamErr) return reject(streamErr);
            const chunks: Buffer[] = [];
            stream.on('data', (c: Buffer) => chunks.push(c));
            stream.on('end', () => {
              const value = Buffer.concat(chunks).toString('utf8').trim();
              if (value.startsWith('application/vnd.oasis.opendocument.')) {
                odfMime = value;
              }
              zipfile.readEntry();
            });
            stream.on('error', reject);
          });
          return;
        }
        zipfile.readEntry();
      });
      zipfile.on('end', () => resolve());
      zipfile.on('error', reject);
    });
  });

  if (odfMime) return odfMime;
  if (entryNames.has('xl/workbook.xml')) {
    return 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
  }
  if (entryNames.has('word/document.xml')) {
    return 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
  }
  if (entryNames.has('ppt/presentation.xml')) {
    return 'application/vnd.openxmlformats-officedocument.presentationml.presentation';
  }
  return undefined;
}
