import type { Element, Node } from '@xmldom/xmldom';
import type { ExtractMetadata, FileParser, ParserResult, Section } from '../types';
import { extractFiles, parseXml } from '../util';

/**
 * Parser for OpenDocument formats: `.odt`, `.ods`, `.odp`, `.odg`, `.odf`.
 *
 * Emits a `body` section for the main content and a separate `notes` section
 * for `.odp` speaker notes. Core metadata is read from `meta.xml`.
 */
export class OpenOfficeParser implements FileParser {
  readonly mimes = [
    'application/vnd.oasis.opendocument.text',
    'application/vnd.oasis.opendocument.spreadsheet',
    'application/vnd.oasis.opendocument.presentation',
    'application/vnd.oasis.opendocument.graphics',
    'application/vnd.oasis.opendocument.formula',
  ] as const;

  async parse(file: Buffer): Promise<ParserResult> {
    const MAIN = 'content.xml';
    const META = 'meta.xml';
    const OBJECT_CONTENT = /Object \d+\/content\.xml/;
    const ALLOWED_TAGS = ['text:p', 'text:h'];
    const NOTES_TAG = 'presentation:notes';

    const files = await extractFiles(
      file,
      (path) => path === MAIN || path === META || OBJECT_CONTENT.test(path),
    );

    const contentFiles = files
      .filter((f) => f.path === MAIN || OBJECT_CONTENT.test(f.path))
      .sort((a, b) => a.path.localeCompare(b.path));

    const notesText: string[] = [];
    const bodyChunks: string[] = [];

    const isNotesNode = (n: Element): boolean =>
      n.tagName === NOTES_TAG ? true : n.parentNode ? isNotesNode(n.parentNode as Element) : false;

    const isInsideAllowedTag = (n: Element): boolean =>
      ALLOWED_TAGS.includes(n.tagName)
        ? true
        : n.parentNode
          ? isInsideAllowedTag(n.parentNode as Element)
          : false;

    const traverse = (node: Node, out: string[], first: boolean): void => {
      if (!node.childNodes || node.childNodes.length === 0) {
        const parent = node.parentNode as Element | null;
        if (parent && parent.tagName?.startsWith('text') && node.nodeValue) {
          const target = isNotesNode(parent) ? notesText : out;
          target.push(node.nodeValue);
          if (ALLOWED_TAGS.includes(parent.tagName) && !first) target.push('\n');
        }
        return;
      }
      for (let i = 0; i < node.childNodes.length; i++) {
        traverse(node.childNodes[i], out, false);
      }
    };

    for (const cf of contentFiles) {
      const doc = parseXml(cf.content.toString());
      const nodes = Array.from(doc.getElementsByTagName('*')).filter(
        (n) => ALLOWED_TAGS.includes(n.tagName) && !isInsideAllowedTag(n.parentNode as Element),
      );

      const chunk = nodes
        .map((n) => {
          const acc: string[] = [];
          traverse(n, acc, true);
          return acc.join('');
        })
        .filter((t) => t.trim() !== '')
        .join('\n');

      if (chunk) bodyChunks.push(chunk);
    }

    const sections: Section[] = [];
    const bodyText = bodyChunks.join('\n\n');
    if (bodyText) sections.push({ kind: 'body', text: bodyText });
    const notes = notesText.join('').trim();
    if (notes) sections.push({ kind: 'notes', label: 'Notes', text: notes });

    const metaFile = files.find((f) => f.path === META);
    const metadata = metaFile ? parseMeta(metaFile.content.toString()) : {};

    return { sections, metadata };
  }
}

function parseMeta(xml: string): Partial<ExtractMetadata> {
  const doc = parseXml(xml);
  const get = (tag: string) => {
    const el = doc.getElementsByTagName(tag)[0];
    const v = el?.childNodes[0]?.nodeValue?.trim();
    return v || undefined;
  };
  const created = get('meta:creation-date');
  const modified = get('dc:date');
  const keywordEls = Array.from(doc.getElementsByTagName('meta:keyword'));
  const keywords = keywordEls
    .map((n) => n.childNodes[0]?.nodeValue?.trim())
    .filter((s): s is string => Boolean(s));
  return {
    title: get('dc:title'),
    author: get('meta:initial-creator') ?? get('dc:creator'),
    subject: get('dc:subject'),
    language: get('dc:language'),
    keywords: keywords.length ? keywords : undefined,
    createdAt: created ? new Date(created) : undefined,
    modifiedAt: modified ? new Date(modified) : undefined,
  };
}
