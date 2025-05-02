export type AnyParserMethod = {
  mimes: string[];
  apply: (_: Buffer, ___: ExtractingOptions, ____: ExtractorConfig) => Promise<string>;
};

export type ExtractedFile = {
  path: string;
  content: Buffer;
};

export type ExtractorConfig = {
  llm?: {
    llmProvider: 'openai' | 'google' | 'anthropic';
    visionModel: string;
    apikey: string;
  };
  confluence?: {
    baseUrl: string;
    email: string;
    apiKey: string;
  };
};

export type ExtractingOptions = {
  extractImages: boolean;
  imageExtractionMethod: 'llm' | 'ocr';
  language: SupportedOCRLanguage;
};

export type ConfluenceOptions = {
  extractAttachments: boolean;
  extractImages: boolean;
  imageExtractionMethod: 'llm' | 'ocr';
  language: SupportedOCRLanguage;
};

export type SupportedOCRLanguage =
  | 'afr'
  | 'amh'
  | 'ara'
  | 'asm'
  | 'aze'
  | 'aze_cyrl'
  | 'bel'
  | 'ben'
  | 'bod'
  | 'bos'
  | 'bul'
  | 'cat'
  | 'ceb'
  | 'ces'
  | 'chi_sim'
  | 'chi_tra'
  | 'chr'
  | 'cym'
  | 'dan'
  | 'deu'
  | 'dzo'
  | 'ell'
  | 'eng'
  | 'enm'
  | 'epo'
  | 'est'
  | 'eus'
  | 'fas'
  | 'fin'
  | 'fra'
  | 'frk'
  | 'frm'
  | 'gle'
  | 'glg'
  | 'grc'
  | 'guj'
  | 'hat'
  | 'heb'
  | 'hin'
  | 'hrv'
  | 'hun'
  | 'iku'
  | 'ind'
  | 'isl'
  | 'ita'
  | 'ita_old'
  | 'jav'
  | 'jpn'
  | 'kan'
  | 'kat'
  | 'kat_old'
  | 'kaz'
  | 'khm'
  | 'kir'
  | 'kor'
  | 'kur'
  | 'lao'
  | 'lat'
  | 'lav'
  | 'lit'
  | 'mal'
  | 'mar'
  | 'mkd'
  | 'mlt'
  | 'msa'
  | 'mya'
  | 'nep'
  | 'nld'
  | 'nor'
  | 'ori'
  | 'pan'
  | 'pol'
  | 'por'
  | 'pus'
  | 'ron'
  | 'rus'
  | 'san'
  | 'sin'
  | 'slk'
  | 'slv'
  | 'spa'
  | 'spa_old'
  | 'sqi'
  | 'srp'
  | 'srp_latn'
  | 'swa'
  | 'swe'
  | 'syr'
  | 'tam'
  | 'tel'
  | 'tgk'
  | 'tgl'
  | 'tha'
  | 'tir'
  | 'tur'
  | 'uig'
  | 'ukr'
  | 'urd'
  | 'uzb'
  | 'uzb_cyrl'
  | 'vie'
  | 'yid';

export type ExtractedXmlItem = {
  type: string;
  content: string;
};
