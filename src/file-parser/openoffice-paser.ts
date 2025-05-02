import { AnyParserMethod } from '../types';
import { extractFiles, parseString } from '../util';
import { Element, Node } from '@xmldom/xmldom';

export class OpenOfficeParser implements AnyParserMethod {
  mimes = [
    'application/vnd.oasis.opendocument.text',
    'application/vnd.oasis.opendocument.spreadsheet',
    'application/vnd.oasis.opendocument.presentation',
    'application/vnd.oasis.opendocument.graphics',
    'application/vnd.oasis.opendocument.formula',
  ];

  apply = async (file: Buffer): Promise<string> => {
    const MAIN_CONTENT_FILE = 'content.xml';
    const OBJECT_CONTENT_REGEX = /Object \d+\/content.xml/;

    try {
      const files = await extractFiles(
        file,
        (path) => path === MAIN_CONTENT_FILE || OBJECT_CONTENT_REGEX.test(path),
      );

      const contentFiles = files
        .filter((file) => file.path === MAIN_CONTENT_FILE || OBJECT_CONTENT_REGEX.test(file.path))
        .sort((a, b) => a.path.localeCompare(b.path));

      const notesText: string[] = [];
      const outputChunks: string[] = [];

      const ALLOWED_TEXT_TAGS = ['text:p', 'text:h'];
      const NOTES_TAG = 'presentation:notes';

      const extractAllTextsFromNode = (root: Element): string => {
        const textArray: string[] = [];
        traverseNode(root, textArray, true);
        return textArray.join('');
      };

      const traverseNode = (node: Node, textArray: string[], isFirstRecursion: boolean): void => {
        if (!node.childNodes || node.childNodes.length === 0) {
          if (
            node.parentNode &&
            (node.parentNode as Element).tagName.startsWith('text') &&
            node.nodeValue
          ) {
            const parent = node.parentNode as Element;
            if (isNotesNode(parent)) {
              notesText.push(node.nodeValue);
              if (ALLOWED_TEXT_TAGS.includes(parent.tagName) && !isFirstRecursion) {
                notesText.push('\n');
              }
            } else {
              textArray.push(node.nodeValue);
              if (ALLOWED_TEXT_TAGS.includes(parent.tagName) && !isFirstRecursion) {
                textArray.push('\n');
              }
            }
          }
          return;
        }

        for (let i = 0; i < node.childNodes.length; i++) {
          traverseNode(node.childNodes[i], textArray, false);
        }
      };

      const isNotesNode = (node: Element): boolean => {
        return node.tagName === NOTES_TAG
          ? true
          : node.parentNode
            ? isNotesNode(node.parentNode as Element)
            : false;
      };

      const isInvalidTextNode = (node: Element): boolean => {
        return ALLOWED_TEXT_TAGS.includes(node.tagName)
          ? true
          : node.parentNode
            ? isInvalidTextNode(node.parentNode as Element)
            : false;
      };

      for (const contentFile of contentFiles) {
        const xmlDoc = parseString(contentFile.content.toString());
        const textNodes = Array.from(xmlDoc.getElementsByTagName('*')).filter(
          (node) =>
            ALLOWED_TEXT_TAGS.includes(node.tagName) &&
            !isInvalidTextNode(node.parentNode as Element),
        );

        const textChunk = textNodes
          .map((node) => extractAllTextsFromNode(node))
          .filter((text) => text.trim() !== '')
          .join('\n');

        if (textChunk) {
          outputChunks.push(textChunk);
        }
      }

      return [...outputChunks, ...notesText].join('\n\n');
    } catch (error) {
      console.error('AnyExtractor: Error parsing OpenOffice file:', error);
      throw error;
    }
  };
}
