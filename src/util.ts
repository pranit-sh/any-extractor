import { readFile as read } from 'node:fs/promises';
import { fetch } from 'undici';
import yauzl from 'yauzl';
import { ERRORMSG } from './constant';
import { ExtractedFile } from './types';
import concat from 'concat-stream';
import { DOMParser } from '@xmldom/xmldom';

export const readFile = async (filePath: string): Promise<Buffer> =>
  (await read(filePath)) as unknown as Buffer;

export const readFileUrl = async (url: string): Promise<Buffer> => {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Failed to fetch: ${res.statusText}`);
  return Buffer.from(await res.arrayBuffer());
}

export const extractFiles = (zipInput: Buffer | string, filterFn: (x: string) => boolean): Promise<ExtractedFile[]> => {
  return new Promise((res, rej) => {
    const processZipfile = (zipfile: yauzl.ZipFile) => {
      const extractedFiles: ExtractedFile[] = [];
      zipfile.readEntry();

      function processEntry(entry: yauzl.Entry) {
        if (filterFn(entry.fileName)) {
          zipfile.openReadStream(entry, (err, readStream) => {
            if (err)
              return rej(err);

            readStream.pipe(concat((data: Buffer) => {
              extractedFiles.push({
              path: entry.fileName,
              content: data.toString()
              });
              zipfile.readEntry();
            }));
          });
        }
        else
          zipfile.readEntry();
      }

      zipfile.on('entry', processEntry);
      zipfile.on('end', () => res(extractedFiles));
      zipfile.on('error', rej);
    };

    if (Buffer.isBuffer(zipInput)) {
      yauzl.fromBuffer(zipInput, { lazyEntries: true }, (err, zipfile) => {
        if (err) return rej(err);
        processZipfile(zipfile);
      });
    }
    else if (typeof zipInput === 'string') {
      yauzl.open(zipInput, { lazyEntries: true }, (err, zipfile) => {
        if (err) return rej(err);
        processZipfile(zipfile);
      });
    }
    else
      rej(ERRORMSG.invalidInput);
  });
}

export const parseString = (xml: string) => {
  let parser = new DOMParser();
  return parser.parseFromString(xml, "text/xml");
};