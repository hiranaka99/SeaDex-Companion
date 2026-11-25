/**
 * A request failure with a deliberate HTTP status. Handlers throw it and the server turns it
 * into the response; `fields` joins the JSON error body (for example `ok: false`).
 */
export class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly fields: Record<string, unknown> = {},
  ) {
    super(message)
  }
}
