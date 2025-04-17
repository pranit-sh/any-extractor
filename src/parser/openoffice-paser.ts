import { ERRORMSG } from "../constant";
import { AnyParserMethod } from "../types";
import { extractFiles, parseString } from "../util";
import { Element, Node } from "@xmldom/xmldom";

export class OpenOfficeParser implements AnyParserMethod {
  mimes = ["application/vnd.oasis.opendocument.text",
    "application/vnd.oasis.opendocument.spreadsheet",
    "application/vnd.oasis.opendocument.presentation",
    "application/vnd.oasis.opendocument.graphics",
    "application/vnd.oasis.opendocument.formula"];

  apply = async (file: Buffer): Promise<string> => {
    const mainContentFilePath = 'content.xml';
    const objectContentFilesRegex = /Object \d+\/content.xml/g;

    try {
      const files = await extractFiles(file, x => x == mainContentFilePath || !!x.match(objectContentFilesRegex));

      if (!files.map(file => file.path).includes(mainContentFilePath)) {
        throw ERRORMSG.fileCorrupted("TODO: figure this out");
      }

      const xmlContentFilesObject = {
        mainContentFile: files.filter(file => file.path == mainContentFilePath).map(file => file.content)[0],
        objectContentFiles: files.filter(file => file.path.match(objectContentFilesRegex)).map(file => file.content),
      };

      let notesText: string[] = [];
      let responseText: string[] = [];

      const allowedTextTags = ["text:p", "text:h"];
      const notesTag = "presentation:notes";

      function extractAllTextsFromNode(root: Element): string {
        let xmlTextArray: string[] = [];
        for (let i = 0; i < root.childNodes.length; i++) {
          traversal(root.childNodes[i], xmlTextArray, true);
        }
        return xmlTextArray.join("");
      }

      function traversal(node: Node, xmlTextArray: string[], isFirstRecursion: boolean): void {
        if (!node.childNodes || node.childNodes.length == 0) {
          if (node.parentNode && (node.parentNode as Element).tagName.indexOf('text') == 0 && node.nodeValue) {
            if (isNotesNode(node.parentNode as Element)) {
              notesText.push(node.nodeValue);
              if (allowedTextTags.includes((node.parentNode as Element).tagName) && !isFirstRecursion) {
                notesText.push("\n");
              }
            } else {
              xmlTextArray.push(node.nodeValue);
              if (allowedTextTags.includes((node.parentNode as Element).tagName) && !isFirstRecursion) {
                xmlTextArray.push("\n");
              }
            }
          }
          return;
        }

        for (let i = 0; i < node.childNodes.length; i++) {
          traversal(node.childNodes[i] as Element, xmlTextArray, false);
        }
      }

      function isNotesNode(node: Element): boolean {
        if (node.tagName == notesTag) {
          return true;
        }
        if (node.parentNode) {
          return isNotesNode(node.parentNode as Element);
        }
        return false;
      }

      function isInvalidTextNode(node: Element) {
        if (allowedTextTags.includes(node.tagName)) {
          return true;
        }
        if (node.parentNode) {
          return isInvalidTextNode(node.parentNode as Element);
        }
        return false;
      }

      const xmlContentArray = [xmlContentFilesObject.mainContentFile, ...xmlContentFilesObject.objectContentFiles].map(xmlContent => parseString(xmlContent));
      xmlContentArray.forEach(xmlContent => {
        const xmlTextNodesList = [...Array.from(xmlContent
          .getElementsByTagName("*"))
          .filter(node => allowedTextTags.includes(node.tagName)
            && !isInvalidTextNode(node.parentNode as Element))];
        responseText.push(
          xmlTextNodesList
            .map(textNode => extractAllTextsFromNode(textNode))
            .filter(text => text != "")
            .join("\n")
        );
      });

      responseText = [...responseText, ...notesText];
      return responseText.join("\n");

    } catch (error) {
      console.error("Error parsing OpenOffice file:", error);
      throw error;
    }
  }
}