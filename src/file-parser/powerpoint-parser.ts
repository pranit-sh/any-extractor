import * as posix from 'path/posix';
import type {
  ExtractMetadata,
  ExtractedImage,
  FileParser,
  ParserContext,
  ParserResult,
  Section,
} from '../types';
import { extractFiles, parseXml } from '../util';
import { guessImageMime, parseCoreProperties } from './ooxml-utils';

/**
 * Parser for `.pptx` (Office Open XML presentation) files.
 *
 * Emits one `slide` section per slide (in slide order), followed by
 * matching `notes` sections for any speaker notes. Images referenced by a
 * slide are attached as {@link ExtractedImage} entries on that slide's
 * section. If {@link ExtractorConfig.onImage} is set, its return value is
 * stored on `image.description` — it is NOT inlined into `section.text`.
 */
export class PowerPointParser implements FileParser {
  readonly mimes = [
    'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  ] as const;

  async parse(file: Buffer, context: ParserContext): Promise<ParserResult> {
    const slideXmlRegex = /^ppt\/slides\/slide(\d+)\.xml$/;
    const slideRelsRegex = /^ppt\/slides\/_rels\/slide(\d+)\.xml\.rels$/;
    const notesXmlRegex = /^ppt\/notesSlides\/notesSlide(\d+)\.xml$/;
    const imageRegex = /^ppt\/media\/image\d+\..+$/i;
    const coreRegex = /^docProps\/core\.xml$/;

    const files = await extractFiles(
      file,
      (p) =>
        slideXmlRegex.test(p) ||
        slideRelsRegex.test(p) ||
        notesXmlRegex.test(p) ||
        imageRegex.test(p) ||
        coreRegex.test(p),
    );

    const slides: Record<number, string> = {};
    const rels: Record<number, { path: string; xml: string }> = {};
    const notes: Record<number, string> = {};
    const images: Record<string, Buffer> = {};
    let coreXml: string | undefined;

    for (const f of files) {
      let m: RegExpMatchArray | null;
      if ((m = f.path.match(slideXmlRegex))) {
        slides[+m[1]] = f.content.toString();
      } else if ((m = f.path.match(slideRelsRegex))) {
        rels[+m[1]] = { path: f.path, xml: f.content.toString() };
      } else if ((m = f.path.match(notesXmlRegex))) {
        notes[+m[1]] = f.content.toString();
      } else if (imageRegex.test(f.path)) {
        images[f.path] = f.content;
      } else if (coreRegex.test(f.path)) {
        coreXml = f.content.toString();
      }
    }

    const onImage = context.config.onImage;
    const orderedSlides = Object.keys(slides)
      .map(Number)
      .sort((a, b) => a - b);

    const sections: Section[] = [];

    for (const n of orderedSlides) {
      const slideText = extractTextFromXml(slides[n]);
      const slideImages: ExtractedImage[] = [];

      const rel = rels[n];
      if (rel) {
        const relDir = posix.dirname(rel.path); // "ppt/slides/_rels"
        const anchor = posix.dirname(relDir); // "ppt/slides"
        for (const target of extractImagePathsFromRels(rel.xml)) {
          const fullPath = posix.normalize(posix.join(anchor, target));
          const buffer = images[fullPath];
          if (!buffer) continue;

          const mime = guessImageMime(fullPath);
          const image: ExtractedImage = {
            mime,
            path: fullPath,
            bytes: buffer.length,
          };

          if (onImage) {
            try {
              const description = await onImage(buffer, mime);
              if (description) image.description = description;
            } catch {
              // Swallow — consistent policy across parsers.
            }
          }

          slideImages.push(image);
        }
      }

      if (slideText || slideImages.length) {
        sections.push({
          kind: 'slide',
          index: n,
          label: `Slide ${n}`,
          text: slideText,
          ...(slideImages.length ? { images: slideImages } : {}),
        });
      }

      const notesXml = notes[n];
      if (notesXml) {
        const notesText = extractTextFromXml(notesXml);
        if (notesText) {
          sections.push({
            kind: 'notes',
            index: n,
            label: `Slide ${n} — Notes`,
            text: notesText,
          });
        }
      }
    }

    const metadata: Partial<ExtractMetadata> = {
      slideCount: orderedSlides.length,
      ...(coreXml ? parseCoreProperties(coreXml) : {}),
    };

    return { sections, metadata };
  }
}

function extractTextFromXml(xml: string): string {
  const paragraphs = parseXml(xml).getElementsByTagName('a:p');
  return Array.from(paragraphs)
    .filter((p) => p.getElementsByTagName('a:t').length > 0)
    .map((p) =>
      Array.from(p.getElementsByTagName('a:t'))
        .map((t) => t.childNodes[0]?.nodeValue ?? '')
        .join(''),
    )
    .join('\n');
}

function extractImagePathsFromRels(xml?: string): string[] {
  if (!xml) return [];
  const rels = parseXml(xml).getElementsByTagName('Relationship');
  return Array.from(rels)
    .filter((r) => r.getAttribute('Type')?.includes('/image') && r.getAttribute('Target'))
    .map((r) => r.getAttribute('Target')!);
}
