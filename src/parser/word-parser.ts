import { ERRORMSG } from "../constant";
import { AnyParserMethod } from "../types";
import { extractFiles, parseString } from "../util";

export class WordParser implements AnyParserMethod {
  mimes = ["application/vnd.openxmlformats-officedocument.wordprocessingml.document"];

  async apply(file: Buffer): Promise<string> {
    const mainContentFileRegex = /word\/document[\d+]?.xml/g;
    const footnotesFileRegex = /word\/footnotes[\d+]?.xml/g;
    const endnotesFileRegex = /word\/endnotes[\d+]?.xml/g;

    try {
      const files = await extractFiles(file, x =>
        [mainContentFileRegex, footnotesFileRegex, endnotesFileRegex].some(fileRegex => x.match(fileRegex))
      );

      if (!files.some(file => file.path.match(mainContentFileRegex))) {
        throw ERRORMSG.fileCorrupted("TODO: figure this out");
      }

      const xmlContentArray = files
        .filter(file => file.path.match(mainContentFileRegex) || file.path.match(footnotesFileRegex) || file.path.match(endnotesFileRegex))
        .map(file => file.content);

      let responseText: string[] = [];

      xmlContentArray.forEach(xmlContent => {
        const xmlParagraphNodesList = parseString(xmlContent).getElementsByTagName("w:p");
        responseText.push(
          Array.from(xmlParagraphNodesList)
            .filter(paragraphNode => paragraphNode.getElementsByTagName("w:t").length != 0)
            .map(paragraphNode => {
              const xmlTextNodeList = paragraphNode.getElementsByTagName("w:t");
              return Array.from(xmlTextNodeList)
                .filter(textNode => textNode.childNodes[0] && textNode.childNodes[0].nodeValue)
                .map(textNode => textNode.childNodes[0].nodeValue)
                .join("");
            })
            .join("\n")
        );
      });
      const responseTextString = responseText.join("\n");
      return responseTextString;
    } catch (error) {
      console.error("Error parsing Word file:", error);
      throw error;
    }
  }
}
