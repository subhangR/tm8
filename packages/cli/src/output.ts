/**
 * Output discipline: stdout carries the RESULT, stderr carries commentary.
 *
 * `worker init` pipes its stdout straight into an agent's context, so a stray
 * "connecting…" line on stdout is a line of garbage in a system prompt. Every
 * diagnostic goes to stderr; `--json` makes stdout machine-readable.
 */
export function emit(json: boolean, payload: unknown, human: string): void {
  process.stdout.write(json ? `${JSON.stringify(payload, null, 2)}\n` : `${human}\n`);
}

export function note(message: string): void {
  process.stderr.write(`${message}\n`);
}
