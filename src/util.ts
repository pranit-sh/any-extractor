import yauzl from 'yauzl';
import { DOMParser } from '@xmldom/xmldom';
import type { ExtractedFile } from './types';

/** Fetch a URL and return the response body as a Buffer. */
export async function readFileUrl(url: string, signal?: AbortSignal): Promise<Buffer> {
  const res = await fetch(url, signal ? { signal } : undefined);
  if (!res.ok) {
    throw new Error(`any-extractor: failed to fetch ${url} — ${res.status} ${res.statusText}`);
  }
  return Buffer.from(await res.arrayBuffer());
}

/**
 * Throw if the signal has been aborted. Uses the signal's `reason` when
 * present so callers see the original cancellation cause (e.g. a
 * `TimeoutError` from `AbortSignal.timeout`).
 */
export function throwIfAborted(signal?: AbortSignal): void {
  if (!signal?.aborted) return;
  const reason = signal.reason;
  if (reason instanceof Error) throw reason;
  throw new DOMException('The operation was aborted.', 'AbortError');
}

/**
 * Combine a user-provided {@link AbortSignal} with an optional timeout
 * (in milliseconds) into a single signal. Returns the original signal
 * unchanged when no timeout is set and only one input is provided, so
 * the fast path allocates nothing.
 *
 * The returned `dispose` clears any internal timer — always call it in a
 * `finally` block to avoid leaking a `setTimeout` handle after a fast
 * success.
 */
export function combineSignals(
  signal: AbortSignal | undefined,
  timeoutMs: number | undefined,
): { signal: AbortSignal | undefined; dispose: () => void } {
  const hasTimeout = typeof timeoutMs === 'number' && timeoutMs > 0 && Number.isFinite(timeoutMs);
  if (!hasTimeout) return { signal, dispose: () => {} };

  const timeoutSignal = AbortSignal.timeout(timeoutMs);
  if (!signal) return { signal: timeoutSignal, dispose: () => {} };

  // Node 20+ ships `AbortSignal.any`; fall back to a manual merge for older runtimes.
  const anyFn = (AbortSignal as unknown as { any?: (signals: AbortSignal[]) => AbortSignal }).any;
  if (typeof anyFn === 'function') {
    return { signal: anyFn([signal, timeoutSignal]), dispose: () => {} };
  }

  const controller = new AbortController();
  const onAbort = (source: AbortSignal) => () => {
    if (!controller.signal.aborted) controller.abort(source.reason);
  };
  const a = onAbort(signal);
  const b = onAbort(timeoutSignal);
  if (signal.aborted) controller.abort(signal.reason);
  else signal.addEventListener('abort', a, { once: true });
  if (timeoutSignal.aborted) controller.abort(timeoutSignal.reason);
  else timeoutSignal.addEventListener('abort', b, { once: true });

  return {
    signal: controller.signal,
    dispose: () => {
      signal.removeEventListener('abort', a);
      timeoutSignal.removeEventListener('abort', b);
    },
  };
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
