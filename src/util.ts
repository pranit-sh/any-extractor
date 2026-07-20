import concat from 'concat-stream';
import yauzl from 'yauzl';
import { DOMParser } from '@xmldom/xmldom';
import type { ExtractedFile } from './types';

/** Fetch a URL and return the response body as a Buffer. */
export async function readFileUrl(url: string, authHeader?: string): Promise<Buffer> {
  const res = await fetch(url, {
    headers: authHeader ? { Authorization: authHeader } : undefined,
  });
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
          stream.pipe(
            concat((data: Buffer) => {
              out.push({ path: entry.fileName, content: data });
              zipfile.readEntry();
            }),
          );
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
