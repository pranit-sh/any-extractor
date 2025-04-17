import { ERRORMSG } from "../constant";
import { AnyParserMethod } from "../types";
import { extractFiles, parseString } from "../util";

export class PowerPointParser implements AnyParserMethod {
  mimes = ["application/vnd.openxmlformats-officedocument.presentationml.presentation"];

  async apply(file: Buffer): Promise<string> {
    const allFilesRegex = /ppt\/(notesSlides|slides)\/(notesSlide|slide)\d+.xml/g;
    const slidesRegex = /ppt\/slides\/slide\d+.xml/g;
    const slideNumberRegex = /lide(\d+)\.xml/;

    try {
      const files = await extractFiles(file, x => !!x.match(allFilesRegex));

      files.sort((a, b) => {
        const matchedANumber = parseInt(a.path.match(slideNumberRegex)?.at(1) ?? "", 10);
        const matchedBNumber = parseInt(b.path.match(slideNumberRegex)?.at(1) ?? "", 10);

        const aNumber = isNaN(matchedANumber) ? Infinity : matchedANumber;
        const bNumber = isNaN(matchedBNumber) ? Infinity : matchedBNumber;

        return aNumber - bNumber || Number(a.path.includes('notes')) - Number(b.path.includes('notes'));
      });

      if (files.length == 0 || !files.map(file => file.path).some(filename => filename.match(slidesRegex))) {
        throw ERRORMSG.fileCorrupted("TODO: figure this out");
      }

      files.sort((a, b) => a.path.indexOf("notes") - b.path.indexOf("notes"));

      const xmlContentArray = files.map(file => file.content);

      let responseText: string[] = [];

      for (const xmlContent of xmlContentArray) {
        const xmlParagraphNodesList = parseString(xmlContent).getElementsByTagName("a:p");
        responseText.push(
          Array.from(xmlParagraphNodesList)
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
      const responseTextString = responseText.join("\n");
      return responseTextString;
    } catch (error) {
      console.error("Error parsing PowerPoint file:", error);
      throw error;
    }
  }
}