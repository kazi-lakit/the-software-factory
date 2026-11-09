/**
 * The largest doc body, in UTF-8 bytes, a Blocks String field holds.
 * Measured live on 2026-11-10: 8 MiB also round-tripped; capped at 4 MiB so reads stay quick.
 */
export const MAX_DOC_BYTES = 4_194_304;

export class DocTooLargeError extends Error {
  constructor(bytes: number) {
    super(`doc body is ${bytes} bytes; the limit is ${MAX_DOC_BYTES}`);
    this.name = 'DocTooLargeError';
  }
}
