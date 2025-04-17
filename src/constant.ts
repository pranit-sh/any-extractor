/** Header for error messages */
export const ERRORHEADER = "[AnyExtractor]: ";

/** Error messages */
export const ERRORMSG = {
  extensionUnsupported: (ext: string) => `Sorry, AnyExtractor currently support docx, pptx, xlsx, odt, odp, ods, pdf files only. Create a ticket in Issues on github to add support for ${ext} files. Stay tuned for further updates.`,
  fileCorrupted: (filepath: string) => `Your file ${filepath} seems to be corrupted. If you are sure it is fine, please create a ticket in Issues on github with the file to reproduce error.`,
  fileDoesNotExist: (filepath: string) => `File ${filepath} could not be found! Check if the file exists or verify if the relative path to the file is correct from your terminal's location.`,
  locationNotFound: (location: string) => `Entered location ${location} is not reachable! Please make sure that the entered directory location exists. Check relative paths and reenter.`,
  improperArguments: `Improper arguments`,
  improperBuffers: `Error occured while reading the file buffers`,
  invalidInput: `Invalid input type: Expected a Buffer or a valid file path`
}