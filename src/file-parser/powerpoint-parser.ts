import type { Element } from '@xmldom/xmldom';
import { makeSection } from '../blocks';
import type {
  Block,
  BlockPos,
  ExtractedFile,
  FileParser,
  ParserContext,
  ParserResult,
  Section,
} from '../types';
import { extractFiles, parseXml } from '../util';
import { guessImageMime, parseCoreProperties } from './ooxml-utils';

/**
 * Parser for `.pptx` decks. Emits one {@link Section} per slide
 * (`kind: 'slide'`) containing headings/paragraphs/lists/tables/images.
 */
export class PowerPointParser implements FileParser {
  readonly mimes = [
    'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  ] as const;

  async parse(file: Buffer, ctx: ParserContext): Promise<ParserResult> {
    const files = await extractFiles(file, (path) =>
      /^ppt\/(slides\/slide\d+\.xml|slides\/_rels\/slide\d+\.xml\.rels|media\/)|^docProps\/core\.xml$/.test(
        path,
      ),
    );

    const slideFiles = files
      .filter((f) => /^ppt\/slides\/slide\d+\.xml$/.test(f.path))
      .sort((a, b) => slideIndex(a.path) - slideIndex(b.path));
    const relsByPath: Record<string, ExtractedFile> = {};
    for (const f of files) {
      if (/^ppt\/slides\/_rels\/slide\d+\.xml\.rels$/.test(f.path)) relsByPath[f.path] = f;
    }
    const media: Record<string, ExtractedFile> = {};
    for (const f of files) {
      if (/^ppt\/media\//.test(f.path)) media[f.path.split('/').pop()!] = f;
    }
    const coreFile = files.find((f) => f.path === 'docProps/core.xml');

    const sections: Section[] = [];
    for (let i = 0; i < slideFiles.length; i++) {
      const slide = slideFiles[i];
      const idx = slideIndex(slide.path);
      const relsPath = `ppt/slides/_rels/slide${idx}.xml.rels`;
      const rels = relsByPath[relsPath]
        ? parseSlideRelationships(relsByPath[relsPath].content.toString())
        : { media: {} };

      const blocks = extractSlideBlocks(slide.content.toString(), rels, media, ctx);
      if (blocks.length === 0) continue;
      sections.push(makeSection('slide', blocks, { index: idx, label: `Slide ${idx}` }));
    }

    const metadata = {
      ...(coreFile ? parseCoreProperties(coreFile.content.toString()) : {}),
      slideCount: slideFiles.length,
    };

    return { sections, metadata };
  }
}

function slideIndex(path: string): number {
  const m = /slide(\d+)\.xml/.exec(path);
  return m ? Number(m[1]) : 0;
}

interface SlideRelationships {
  media: Record<string, string>;
}

function parseSlideRelationships(xml: string): SlideRelationships {
  const doc = parseXml(xml);
  const media: Record<string, string> = {};
  for (const rel of Array.from(doc.getElementsByTagName('Relationship'))) {
    const id = rel.getAttribute('Id');
    const target = rel.getAttribute('Target');
    const type = rel.getAttribute('Type') ?? '';
    if (!id || !target) continue;
    if (type.endsWith('/image')) {
      media[id] = target.split('/').pop()!;
    }
  }
  return { media };
}

function extractSlideBlocks(
  xml: string,
  rels: SlideRelationships,
  media: Record<string, ExtractedFile>,
  ctx: ParserContext,
): Block[] {
  const doc = parseXml(xml);
  const spTree = doc.getElementsByTagName('p:spTree')[0] ?? doc.documentElement;
  if (!spTree) return [];

  const blocks: Block[] = [];
  let firstText = true;

  const shapes = Array.from(spTree.childNodes).filter((n) => n.nodeType === 1) as Element[];
  for (const shape of shapes) {
    if (shape.tagName === 'p:sp') {
      const { paragraphs, isTitle } = readShapeParagraphs(shape);
      // Group consecutive bullet paragraphs into a list.
      let bulletBuffer: string[] = [];
      const flushBullets = (): void => {
        if (bulletBuffer.length) {
          blocks.push(ctx.block.list(bulletBuffer, {}));
          bulletBuffer = [];
        }
      };
      for (const p of paragraphs) {
        if (p.bullet) {
          bulletBuffer.push(p.text);
        } else {
          flushBullets();
          if (!p.text) continue;
          if (isTitle && firstText) {
            blocks.push(ctx.block.heading(2, p.text));
            firstText = false;
          } else {
            blocks.push(ctx.block.paragraph(p.text));
          }
        }
      }
      flushBullets();
    } else if (shape.tagName === 'p:graphicFrame') {
      const rows = readGraphicFrameTable(shape);
      if (rows.length) blocks.push(ctx.block.table(rows.slice(1), { headers: rows[0] }));
    } else if (shape.tagName === 'p:pic') {
      const embed = attrOfFirst(shape, 'a:blip', 'r:embed');
      const alt =
        attrOfFirst(shape, 'p:cNvPr', 'descr') ??
        attrOfFirst(shape, 'p:cNvPr', 'title') ??
        undefined;
      const name = embed ? rels.media[embed] : undefined;
      const media0 = name ? media[name] : undefined;
      if (media0) {
        const pos: BlockPos = {};
        blocks.push(
          ctx.block.image(
            {
              mime: guessImageMime(media0.path),
              path: media0.path,
              bytes: media0.content.length,
              ...(alt ? { alt } : {}),
            },
            pos,
          ),
        );
      }
    }
  }
  return blocks;
}

function readShapeParagraphs(shape: Element): {
  paragraphs: { text: string; bullet: boolean }[];
  isTitle: boolean;
} {
  const paragraphs: { text: string; bullet: boolean }[] = [];
  const ph = shape.getElementsByTagName('p:ph')[0];
  const phType = ph?.getAttribute('type') ?? '';
  const isTitle = phType === 'title' || phType === 'ctrTitle';

  for (const p of Array.from(shape.getElementsByTagName('a:p'))) {
    const text = Array.from(p.getElementsByTagName('a:t'))
      .map((t) => t.childNodes[0]?.nodeValue ?? '')
      .join('')
      .trim();
    // A paragraph is a bullet if it has an explicit bullet marker
    // (a:buChar / a:buAutoNum). We treat "no explicit bullet" as
    // non-bullet regardless of layout — cleaner output for LLMs.
    const bullet =
      p.getElementsByTagName('a:buChar').length > 0 ||
      p.getElementsByTagName('a:buAutoNum').length > 0;
    paragraphs.push({ text, bullet: bullet && !isTitle });
  }
  return { paragraphs, isTitle };
}

function readGraphicFrameTable(frame: Element): string[][] {
  const tbl = frame.getElementsByTagName('a:tbl')[0];
  if (!tbl) return [];
  const rows: string[][] = [];
  for (const tr of Array.from(tbl.getElementsByTagName('a:tr'))) {
    const row: string[] = [];
    for (const tc of Array.from(tr.getElementsByTagName('a:tc'))) {
      const text = Array.from(tc.getElementsByTagName('a:t'))
        .map((t) => t.childNodes[0]?.nodeValue ?? '')
        .join('')
        .trim();
      row.push(text);
    }
    if (row.length) rows.push(row);
  }
  return rows;
}

function attrOfFirst(root: Element, tag: string, attr: string): string | undefined {
  const el = root.getElementsByTagName(tag)[0];
  return el?.getAttribute(attr) ?? undefined;
}
