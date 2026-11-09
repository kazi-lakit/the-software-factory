/** The largest doc body, in UTF-8 bytes, a Blocks String field is known to hold (ACR's proven size; Task 8 re-measures it). */
export const MAX_DOC_BYTES = 262_144;

export class DocTooLargeError extends Error {
  constructor(bytes: number) {
    super(`doc body is ${bytes} bytes; the limit is ${MAX_DOC_BYTES}`);
    this.name = 'DocTooLargeError';
  }
}
