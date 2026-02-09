export type AnyParserMethod = {
  mimes: string[];
  apply: (_: Buffer, ____: ExtractorConfig) => Promise<string>;
};

export type ExtractedFile = {
  path: string;
  content: Buffer;
};

export type ExtractorConfig = {
  confluence?: {
    baseUrl: string;
    email: string;
    apiKey: string;
  };
};

export type ExtractedXmlItem = {
  type: string;
  content: string;
};
