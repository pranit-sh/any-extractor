import type {
  ExtractedFile,
  ExtractedImage,
  FileParser,
  ParserContext,
  ParserResult,
  Section,
} from '../types';
import { extractFiles, parseXml } from '../util';
import { guessImageMime, parseCoreProperties } from './ooxml-utils';

/**
 * Parser for `.docx` (Office Open XML) files.
 *
 * Emits the main body as a `body` section, plus optional `footnote` and
 * `endnote` sections. Embedded images are attached to their containing
 * section as {@link ExtractedImage} entries. If {@link ExtractorConfig.onImage}
 * is set, its return value is stored on `image.description` — it is NOT
 * inlined into `section.text` (consumers decide how to use it).
 */
export class WordParser implements FileParser {
  readonly mimes = [
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  ] as const;

  async parse(file: Buffer, context: ParserContext): Promise<ParserResult> {
    const mainRegex = /word\/document\d*\.xml/;
    const footnotesRegex = /word\/footnotes\d*\.xml/;
    const endnotesRegex = /word\/endnotes\d*\.xml/;
    const mediaRegex = /^word\/media\//;
    const relsRegex = /^word\/_rels\/document\.xml\.rels$/;
    const coreRegex = /^docProps\/core\.xml$/;

    const files = await extractFiles(
      file,
      (path) =>
        [mainRegex, footnotesRegex, endnotesRegex, relsRegex, coreRegex].some((r) =>
          r.test(path),
        ) || mediaRegex.test(path),
    );

    const find = (regex: RegExp) => files.find((f) => regex.test(f.path));
    const mainDoc = find(mainRegex);
    const relsFile = find(relsRegex);

    if (!mainDoc || !relsFile) {
      throw new Error('any-extractor: docx is missing main document or relationships file');
    }

    const media: Record<string, ExtractedFile> = {};
    for (const f of files) {
      if (mediaRegex.test(f.path)) {
        media[f.path.split('/').pop()!] = f;
      }
    }

    const embedMap = parseRelationships(relsFile.content.toString());
    const onImage = context.config.onImage;

    const sections: Section[] = [];

    const body = await extractSection(mainDoc.content.toString(), embedMap, media, onImage);
    if (body.text || body.images?.length) {
      sections.push({ kind: 'body', ...body });
    }

    const footnotes = find(footnotesRegex);
    if (footnotes) {
      const s = await extractSection(footnotes.content.toString(), embedMap, media, onImage);
      if (s.text) sections.push({ kind: 'footnote', label: 'Footnotes', ...s });
    }

    const endnotes = find(endnotesRegex);
    if (endnotes) {
      const s = await extractSection(endnotes.content.toString(), embedMap, media, onImage);
      if (s.text) sections.push({ kind: 'endnote', label: 'Endnotes', ...s });
    }

    const coreFile = find(coreRegex);
    const metadata = coreFile ? parseCoreProperties(coreFile.content.toString()) : {};

    return { sections, metadata };
  }
}

function parseRelationships(xml: string): Record<string, string> {
  const doc = parseXml(xml);
  const map: Record<string, string> = {};
  for (const rel of Array.from(doc.getElementsByTagName('Relationship'))) {
    const id = rel.getAttribute('Id');
    const target = rel.getAttribute('Target');
    if (id && target?.startsWith('media/')) {
      map[id] = target.split('/').pop()!;
    }
  }
  return map;
}

async function extractSection(
  xml: string,
  embedMap: Record<string, string>,
  media: Record<string, ExtractedFile>,
  onImage: ((buf: Buffer, mime: string) => Promise<string> | string) | undefined,
): Promise<{ text: string; images?: ExtractedImage[] }> {
  const doc = parseXml(xml);
  const paragraphs = Array.from(doc.getElementsByTagName('w:p'));
  const parts: string[] = [];
  const images: ExtractedImage[] = [];

  for (const p of paragraphs) {
    const texts = Array.from(p.getElementsByTagName('w:t'));
    const line = texts.map((t) => t.childNodes[0]?.nodeValue ?? '').join('');

    for (const drawing of Array.from(p.getElementsByTagName('w:drawing'))) {
      const blip = drawing.getElementsByTagName('a:blip')[0];
      const embedId = blip?.getAttribute('r:embed');
      if (!embedId || !embedMap[embedId]) continue;
      const imageFile = media[embedMap[embedId]];
      if (!imageFile) continue;

      const mime = guessImageMime(imageFile.path);
      const image: ExtractedImage = {
        mime,
        path: imageFile.path,
        bytes: imageFile.content.length,
      };

      if (onImage) {
        try {
          const description = await onImage(imageFile.content, mime);
          if (description) image.description = description;
        } catch {
          // Swallow onImage errors — consistent across parsers.
        }
      }

      images.push(image);
    }

    if (line.trim()) parts.push(line.trim());
  }

  return {
    text: parts.join('\n'),
    ...(images.length ? { images } : {}),
  };
}
