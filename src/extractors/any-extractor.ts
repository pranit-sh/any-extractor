import { parse } from "file-type-mime";
import { AnyParserMethod } from "../types"
import { isValidUrl, readFile, readFileUrl } from "../util";

export class AnyExtractor {
	private parserMap: Map<string, AnyParserMethod> = new Map();
	private parsers: AnyParserMethod[] = [];

	public addParser = (method: AnyParserMethod): this => {
		this.parsers.push(method);
		method.mimes.forEach((mime) => {
			this.parserMap.set(mime, method);
		});
		return this;
	}

	public getRegisteredParsers = (): string[] => {
		return Array.from(this.parserMap.keys());
	}

	public extractText = async (input: string | Buffer): Promise<string> => {
		let preparedInput: Buffer;
		if (typeof input === 'string') {
			if (isValidUrl(input)) {
				preparedInput = await readFileUrl(input);
			} else {
				preparedInput = await readFile(input);
			}
		} else {
			preparedInput = input;
		}
		if (!preparedInput) {
			throw new Error("AnyExtractor: No input provided");
		}

		const mimeDetails = parse(preparedInput.buffer.slice(preparedInput.byteOffset, preparedInput.byteOffset + preparedInput.byteLength) as ArrayBuffer);
		if (!mimeDetails) {
			return preparedInput.toString('utf-8');
		}

		const extractor = this.parserMap.get(mimeDetails.mime);

		if (!extractor?.apply) {
			const message = `AnyExtractor: No extraction method registered for MIME type '${mimeDetails.mime}'`;
			throw new Error(message);
		}

		return extractor.apply(preparedInput)
	}
}