import type { ExtractMetadata } from '../types';
import { parseXml } from '../util';

/**
 * Parse `docProps/core.xml` (shared by Word / Excel / PowerPoint).
 *
 * Returns best-effort core metadata — unknown / empty fields are omitted.
 */
export function parseCoreProperties(xml: string): Partial<ExtractMetadata> {
  const doc = parseXml(xml);
  const get = (tag: string) => {
    const el = doc.getElementsByTagName(tag)[0];
    const v = el?.childNodes[0]?.nodeValue?.trim();
    return v || undefined;
  };
  const created = get('dcterms:created');
  const modified = get('dcterms:modified');
  return {
    title: get('dc:title'),
    author: get('dc:creator'),
    subject: get('dc:subject'),
    language: get('dc:language'),
    keywords: splitKeywords(get('cp:keywords')),
    createdAt: created ? new Date(created) : undefined,
    modifiedAt: modified ? new Date(modified) : undefined,
  };
}

/** Split a comma/semicolon separated keyword string into a clean array. */
export function splitKeywords(raw: string | undefined): string[] | undefined {
  if (!raw) return undefined;
  const out = raw
    .split(/[,;]/)
    .map((k) => k.trim())
    .filter(Boolean);
  return out.length ? out : undefined;
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
