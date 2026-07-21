import type { ExtractMetadata } from '../types';
import { parseXml } from '../util';

/**
 * Parse `docProps/core.xml` (shared by Word / Excel / PowerPoint).
 *
 * Returns only the fields we surface (`title`, `author`). Everything else
 * in core.xml is dropped by design — this package is agent-focused, not a
 * full document introspector.
 */
export function parseCoreProperties(xml: string): Partial<ExtractMetadata> {
  const doc = parseXml(xml);
  const get = (tag: string): string | undefined => {
    const el = doc.getElementsByTagName(tag)[0];
    const v = el?.childNodes[0]?.nodeValue?.trim();
    return v || undefined;
  };
  const out: Partial<ExtractMetadata> = {};
  const title = get('dc:title');
  if (title) out.title = title;
  const author = get('dc:creator');
  if (author) out.author = author;
  return out;
}

const IMAGE_MIME_BY_EXT: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  bmp: 'image/bmp',
  svg: 'image/svg+xml',
};

/** Guess an image MIME type from a file path's extension. */
export function guessImageMime(path: string): string {
  const ext = path.split('.').pop()?.toLowerCase() ?? '';
  return IMAGE_MIME_BY_EXT[ext] ?? 'application/octet-stream';
}
