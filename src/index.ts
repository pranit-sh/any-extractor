import { AnyExtractor } from "./extractors/any-extractor";
import { ExcelParser } from "./parser/excel-parser";
import { OpenOfficeParser } from "./parser/openoffice-paser";
import { PDFParser } from "./parser/pdf-parser";
import { PowerPointParser } from "./parser/powerpoint-parser";
import { WordParser } from "./parser/word-parser";

export const getAnyExtractor = (): AnyExtractor => {
  const anyExtractor = new AnyExtractor();
  
  anyExtractor.addParser(new ExcelParser());
  anyExtractor.addParser(new OpenOfficeParser());
  anyExtractor.addParser(new PDFParser());
  anyExtractor.addParser(new PowerPointParser());
  anyExtractor.addParser(new WordParser());

  return anyExtractor;
}

export * from "./types";