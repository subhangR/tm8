/**
 * Exit codes — the agent-facing contract of this CLI.
 *
 * An agent (or a shell script driving one) must be able to tell "you asked
 * wrong" from "the server said no" from "the server isn't there yet" WITHOUT
 * parsing prose. During G1A the third case is the common one: handlers that
 * are not built answer an honest `501 not_implemented` (DEV-13), and that is a
 * different fact from a rejected command.
 */
export const EXIT_OK = 0;
/** Bad invocation: unknown verb, missing argument, missing/!readable manifest. */
export const EXIT_USAGE = 2;
/** The server answered with a contract error (DEV-8 taxonomy) — it refused. */
export const EXIT_REFUSED = 3;
/** Transport failure, 5xx, or `not_implemented` — the server could not answer. */
export const EXIT_UNAVAILABLE = 4;

export class CliError extends Error {
  constructor(
    message: string,
    readonly code: number = EXIT_USAGE,
    readonly detail?: unknown,
  ) {
    super(message);
    this.name = 'CliError';
  }
}
