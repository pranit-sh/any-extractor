export type InputType = 'buffer' | 'file' | 'fileurl'
export type ExtractionPayload = { type: InputType; input: string | Buffer }

export type AnyParserMethod = {
	mimes: string[];
	apply: (_: Buffer) => Promise<string>;
}

export type ExtractedFile = {
	path: string;
	content: string;
}