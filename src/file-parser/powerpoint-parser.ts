import * as posix from 'path/posix';
import type { Element } from '@xmldom/xmldom';
import { makeSection } from '../blocks';
import type {
  Block,
  ExtractMetadata,
  FileParser,
  ParserContext,
  ParserResult,
  Section,
} from '../types';
import { extractFiles, parseXml } from '../util';
import { guessImageMime, parseCoreProperties } from './ooxml-utils';

/**
 * Parser for `.pptx` files.
 *
 * Emits one `slide` section per slide with a title heading (when present),
 * body paragraphs, and any inline images. Speaker notes get their own
 * `notes` section immediately after each slide.
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
      if ((m = f.path.match(slideXmlRegex))) slides[+m[1]] = f.content.toString();
      else if ((m = f.path.match(slideRelsRegex)))
        rels[+m[1]] = { path: f.path, xml: f.content.toString() };
      else if ((m = f.path.match(notesXmlRegex))) notes[+m[1]] = f.content.toString();
      else if (imageRegex.test(f.path)) images[f.path] = f.content;
      else if (coreRegex.test(f.path)) coreXml = f.content.toString();
    }

    const orderedSlides = Object.keys(slides)
      .map(Number)
      .sort((a, b) => a - b);
    const sections: Section[] = [];

    for (const n of orderedSlides) {
      const slideBlocks: Block[] = [];
      const doc = parseXml(slides[n]);
      const { title, paragraphs } = extractSlideTextStructured(doc);
      const posBase = { page: n };

      if (title) {
        slideBlocks.push(context.block.heading(2, title, posBase));
      }
      for (const p of paragraphs) {
        slideBlocks.push(context.block.paragraph(p, posBase));
      }

      // Images
      const rel = rels[n];
      if (rel) {
        const anchor = posix.dirname(posix.dirname(rel.path));
        const relTargetsByRid = extractImageRelsByRid(rel.xml);
        const altByRid = extractSlidePictureAltByRid(slides[n]);
        for (const [rid, target] of relTargetsByRid) {
          const fullPath = posix.normalize(posix.join(anchor, target));
          const buffer = images[fullPath];
          if (!buffer) continue;
          const mime = guessImageMime(fullPath);
          const description = (await context.describe(buffer)) || undefined;
          const alt = altByRid.get(rid);
          slideBlocks.push(
            context.block.image(
              {
                mime,
                path: fullPath,
                bytes: buffer.length,
                ...(alt ? { alt } : {}),
                description,
              },
              posBase,
            ),
          );
        }
      }

      if (slideBlocks.length) {
        sections.push(makeSection('slide', slideBlocks, { index: n, label: `Slide ${n}` }));
      }

      // Notes
      const notesXml = notes[n];
      if (notesXml) {
        const { paragraphs: notesParas } = extractSlideTextStructured(parseXml(notesXml));
        const notesBlocks = notesParas.map((p) => context.block.paragraph(p, { page: n }));
        if (notesBlocks.length) {
          sections.push(
            makeSection('notes', notesBlocks, {
              index: n,
              label: `Slide ${n} — Notes`,
            }),
          );
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

/**
 * Walk a slide XML and pick out the title (from a shape marked as a title
 * placeholder) plus the remaining body paragraphs.
 */
function extractSlideTextStructured(doc: ReturnType<typeof parseXml>): {
  title?: string;
  paragraphs: string[];
} {
  const paragraphs: string[] = [];
  let title: string | undefined;

  const shapes = Array.from(doc.getElementsByTagName('p:sp')) as Element[];
  for (const sp of shapes) {
    const isTitle = shapeIsTitle(sp);
    const shapeParas = Array.from(sp.getElementsByTagName('a:p')).map(paragraphText);
    if (isTitle) {
      const joined = shapeParas.filter(Boolean).join(' ').trim();
      if (joined && !title) title = joined;
      continue;
    }
    for (const t of shapeParas) if (t) paragraphs.push(t);
  }
  return { title, paragraphs };
}

function shapeIsTitle(sp: Element): boolean {
  const phList = sp.getElementsByTagName('p:ph');
  if (!phList || phList.length === 0) return false;
  const type = phList[0].getAttribute('type') ?? '';
  return type === 'title' || type === 'ctrTitle';
}

function paragraphText(p: Element): string {
  const runs = Array.from(p.getElementsByTagName('a:t'));
  return runs
    .map((t) => t.childNodes[0]?.nodeValue ?? '')
    .join('')
    .trim();
}

function extractImageRelsByRid(xml?: string): Map<string, string> {
  const out = new Map<string, string>();
  if (!xml) return out;
  const rels = parseXml(xml).getElementsByTagName('Relationship');
  for (const r of Array.from(rels)) {
    const type = r.getAttribute('Type') ?? '';
    const target = r.getAttribute('Target');
    const id = r.getAttribute('Id');
    if (id && target && type.includes('/image')) out.set(id, target);
  }
  return out;
}

/**
 * Walk each `<p:pic>` in a slide and map its embed relationship id to the
 * `descr` (or `title`) attribute on `<p:cNvPr>` \u2014 the alt text.
 */
function extractSlidePictureAltByRid(xml: string): Map<string, string> {
  const out = new Map<string, string>();
  const pics = parseXml(xml).getElementsByTagName('p:pic');
  for (const pic of Array.from(pics)) {
    const cNvPr = pic.getElementsByTagName('p:cNvPr')[0];
    const blip = pic.getElementsByTagName('a:blip')[0];
    if (!cNvPr || !blip) continue;
    const rid = blip.getAttribute('r:embed');
    if (!rid) continue;
    const alt = (cNvPr.getAttribute('descr') ?? cNvPr.getAttribute('title') ?? '').trim();
    if (alt) out.set(rid, alt);
  }
  return out;
}
