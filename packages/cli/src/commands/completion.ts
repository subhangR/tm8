/**
 * `tm8 completion bash|zsh|fish` (§4.16).
 *
 * The script is DATA — a caller pipes it into a file or `source`s it — so it
 * goes to stdout, and the documented `tm8 completion bash > /path` usage runs
 * under the DEFAULT human format and therefore writes the raw script.
 *
 * Under `--format json` the same DTO is a JSON string. That is the output law
 * working as intended (human is a rendering of the same DTO, not a second
 * shape) rather than a special case — but it does mean `--format json` is the
 * wrong thing to redirect into a completion file, so the human default is what
 * the help text shows.
 */
import { completionScript, isShell, SHELLS } from '../discovery/completion.js';
import { CliError, EXIT_OK, EXIT_USAGE, type ExitCode } from '../exit.js';
import type { Output } from '../output.js';

export function completion(args: readonly string[], out: Output): ExitCode {
  const shell = args[0];
  if (shell === undefined) {
    throw new CliError(`tm8 completion requires a shell: ${SHELLS.join('|')}`, EXIT_USAGE);
  }
  if (args.length > 1) {
    throw new CliError(
      `tm8 completion takes exactly one shell, got ${args.length}: ${args.join(' ')}`,
      EXIT_USAGE,
    );
  }
  if (!isShell(shell)) {
    throw new CliError(
      `unsupported shell ${JSON.stringify(shell)}; tm8 generates completion for ${SHELLS.join(', ')}`,
      EXIT_USAGE,
    );
  }
  // `data` with an identity renderer: the script IS the DTO here.
  out.data(completionScript(shell), (script) => script.replace(/\n$/, ''));
  return EXIT_OK;
}
