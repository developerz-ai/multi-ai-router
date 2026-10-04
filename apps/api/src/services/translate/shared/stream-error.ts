/** Translation failed after response bytes; preserve HTTP status and forbid retries/health strikes. */
export class TranslationStreamError extends Error {
  constructor(
    readonly errorClass: "translation_protocol_error" | "translation_pending_overflow",
    message: string,
  ) {
    super(message)
    this.name = "TranslationStreamError"
  }
}
