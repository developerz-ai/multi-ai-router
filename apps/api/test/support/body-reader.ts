/** Only the read contract is needed, shared by Bun and DOM response body readers. */
export interface BodyReader {
  read(): Promise<{ done: boolean; value?: Uint8Array }>
}
