import { Element, LiveNodeList } from "@xmldom/xmldom";
import { ERRORMSG } from "../constant";
import { AnyParserMethod } from "../types";
import { extractFiles, parseString } from "../util";

export class ExcelParser implements AnyParserMethod {
  mimes = ["application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"];

  async apply(file: Buffer): Promise<string> {
    const sheetsRegex = /xl\/worksheets\/sheet\d+.xml/g;
    const drawingsRegex = /xl\/drawings\/drawing\d+.xml/g;
    const chartsRegex = /xl\/charts\/chart\d+.xml/g;
    const stringsFilePath = 'xl/sharedStrings.xml';

    try {
      const files = await extractFiles(file, x =>
        [sheetsRegex, drawingsRegex, chartsRegex].some(fileRegex => x.match(fileRegex)) || x == stringsFilePath
      );

      if (files.length == 0 || !files.map(file => file.path).some(filename => filename.match(sheetsRegex))) {
        throw ERRORMSG.fileCorrupted("TODO: figure this out");
      }

      const xmlContentFilesObject = {
        sheetFiles: files.filter(file => file.path.match(sheetsRegex)).map(file => file.content),
        drawingFiles: files.filter(file => file.path.match(drawingsRegex)).map(file => file.content),
        chartFiles: files.filter(file => file.path.match(chartsRegex)).map(file => file.content),
        sharedStringsFile: files.filter(file => file.path == stringsFilePath).map(file => file.content)[0],
      };

      let responseText: string[] = [];

      function isValidInlineStringCNode(cNode: Element): boolean {
        if (cNode.tagName.toLowerCase() != 'c') return false;
        if (cNode.getAttribute("t") != 'inlineStr') return false;
        const childNodesNamedIs: LiveNodeList<Element> = cNode.getElementsByTagName('is');
        if (childNodesNamedIs.length != 1) return false;
        const childNodesNamedT: LiveNodeList<Element> = childNodesNamedIs[0].getElementsByTagName('t');
        if (childNodesNamedT.length != 1) return false;
        return childNodesNamedT[0].childNodes[0] && childNodesNamedT[0].childNodes[0].nodeValue != '';
      }

      function hasValidVNodeInCNode(cNode: Element): boolean {
        const vNodes = cNode.getElementsByTagName("v");
        return vNodes[0] && vNodes[0].childNodes[0] && vNodes[0].childNodes[0].nodeValue != '';
      }

      const sharedStringsXmlTNodesList = xmlContentFilesObject.sharedStringsFile != undefined
        ? parseString(xmlContentFilesObject.sharedStringsFile).getElementsByTagName("t")
        : [];

      const sharedStrings = Array.from(sharedStringsXmlTNodesList)
        .map(tNode => tNode.childNodes[0]?.nodeValue ?? '');

      for (const sheetXmlContent of xmlContentFilesObject.sheetFiles) {
        const sheetsXmlCNodesList = parseString(sheetXmlContent).getElementsByTagName("c");
        responseText.push(
          Array.from(sheetsXmlCNodesList)
            .filter(cNode => isValidInlineStringCNode(cNode) || hasValidVNodeInCNode(cNode))
            .map(cNode => {
              if (isValidInlineStringCNode(cNode))
                return cNode.getElementsByTagName('is')[0].getElementsByTagName('t')[0].childNodes[0].nodeValue;
              if (hasValidVNodeInCNode(cNode)) {
                const isIndexInSharedStrings = cNode.getAttribute("t") == "s";
                const value = parseInt(cNode.getElementsByTagName("v")[0].childNodes[0].nodeValue ?? "", 10);
                if (isIndexInSharedStrings && value >= sharedStrings.length)
                  throw ERRORMSG.fileCorrupted("TODO: figure this out");

                return isIndexInSharedStrings
                  ? sharedStrings[value]
                  : value;
              }
              return '';
            })
            .join("\n")
        );
      }

      for (const drawingXmlContent of xmlContentFilesObject.drawingFiles) {
        const drawingsXmlParagraphNodesList = parseString(drawingXmlContent).getElementsByTagName("a:p");
        responseText.push(
          Array.from(drawingsXmlParagraphNodesList)
            .filter(paragraphNode => paragraphNode.getElementsByTagName("a:t").length != 0)
            .map(paragraphNode => {
              const xmlTextNodeList = paragraphNode.getElementsByTagName("a:t");
              return Array.from(xmlTextNodeList)
                .filter(textNode => textNode.childNodes[0] && textNode.childNodes[0].nodeValue)
                .map(textNode => textNode.childNodes[0].nodeValue)
                .join("");
            })
            .join("\n")
        );
      }

      for (const chartXmlContent of xmlContentFilesObject.chartFiles) {
        const chartsXmlCVNodesList = parseString(chartXmlContent).getElementsByTagName("c:v");
        responseText.push(
          Array.from(chartsXmlCVNodesList)
            .filter(cVNode => cVNode.childNodes[0] && cVNode.childNodes[0].nodeValue)
            .map(cVNode => cVNode.childNodes[0].nodeValue)
            .join("\n")
        );
      }

      return responseText.join("\n");
    } catch (error) {
      console.error("Error parsing Excel file:", error);
      throw error;
    }
  }
}
