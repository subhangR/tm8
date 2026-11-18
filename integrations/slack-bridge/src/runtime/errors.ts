/** Media over the size the server asked for (media.fetch) or Slack takes. */
export class TooLargeError extends Error {
  constructor(public size: number, public max: number) {
    super(`media is ${size} bytes, over the ${max} byte limit`)
  }
}

/** An outbound frame Slack can never take as asked (a poll, an unknown emoji, a pseudo message): not retried. */
export class PermanentError extends Error {
  constructor(public reason: string) {
    super(reason)
  }
}
