import { AnyParserMethod, ExtractionPayload } from "../types"
import { readFileUrl, readFile } from "../util"
import { fileTypeFromBuffer as getFileType } from 'file-type'

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

	public extractText = async ({ input, type }: ExtractionPayload): Promise<string> => {
		let preparedInput: Buffer;
		if (typeof input === 'string') {
			switch (type) {
				case 'file':
					preparedInput = await readFile(input);
					break;
				case 'fileurl':
					preparedInput = await readFileUrl(input);
					break;
				default:
					preparedInput = Buffer.from(input);
			}
		} else {
			preparedInput = input;
		}

		const mimeDetails = await getFileType(preparedInput);
		if (!mimeDetails) return preparedInput.toString('utf-8');

		const extractor = this.parserMap.get(mimeDetails.mime);

		if (!extractor?.apply) {
			const message = `AnyExtractor: No extraction method registered for MIME type '${mimeDetails.mime}'`;
			throw new Error(message);
		}

		return extractor.apply(preparedInput)
	}
}