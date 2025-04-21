export type AnyParserMethod = {
	mimes: string[];
	apply: (_: Buffer) => Promise<string>;
}

export type ExtractedFile = {
	path: string;
	content: string;
}