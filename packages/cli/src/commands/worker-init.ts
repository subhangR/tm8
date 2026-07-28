/**
 * `tm8 worker init` — the harness bootstrap, and the first thing a spawned
 * agent runs.
 *
 * Reads TM8_MANIFEST_PATH, composes the briefing, writes it to stdout. It
 * makes ZERO network calls: the Server may still be finishing the spawn
 * transaction when the PTY starts, and an agent that cannot boot because a
 * status endpoint was slow is a worse failure than one that boots with a
 * slightly stale identity.
 *
 * TWO MANIFEST VERSIONS, ONE COMMAND. A `manifestVersion: "2"` file yields the
 * §5.2 trusted kernel plus one §14 control block; a v1 file yields the legacy
 * persona frame. The branch lives in `parseManifest`/`composePrompt`, not here,
 * so this command does not grow a version conditional — and an agent whose
 * manifest is one version behind its server still boots either way.
 *
 * THIS IS A RE-READ, NOT THE INJECTION. The prompt an agent actually starts
 * with is composed IN-PROCESS by the spawn path and embedded in its command
 * line, so it exists at the first token before any CLI could run. This command
 * shares that exact composer, so the two can never drift; it exists for an
 * agent that wants to re-read its own briefing.
 */
import type { OptionBag } from '../args.js';
import { readEnv } from '../env.js';
import { CliError, EXIT_OK, EXIT_USAGE, type ExitCode } from '../exit.js';
import { readManifest } from '../manifest.js';
import type { Output } from '../output.js';
import { composePrompt } from '../prompt.js';

export function workerInit(options: OptionBag, out: Output): ExitCode {
  const env = readEnv();
  const manifestPath = options.value('manifest') ?? env.manifestPath;

  if (!manifestPath) {
    throw new CliError(
      'no manifest: set TM8_MANIFEST_PATH (the PTY host sets it on spawn) or pass --manifest <path>',
      EXIT_USAGE,
    );
  }

  const manifest = readManifest(manifestPath);
  const envelope = composePrompt(manifest, {
    sessionId: env.sessionId ?? manifest.sessionId,
    baseUrl: env.baseUrl,
  });

  // NOTHING on stderr, deliberately — and this is stronger than the usual
  // "stdout is data" rule. A spawned agent runs this inside a PTY, where
  // stderr and stdout are THE SAME STREAM: a budget note written to stderr for
  // an operator's benefit would land in the middle of the agent's own system
  // prompt. `verbs.test.ts` asserts the silence, and it caught exactly that
  // mistake when a byte-budget note was added here. Budgets are enforced where
  // they are composed (`assertWithinBudget` throws), not narrated here.
  out.data(envelope, (dto) => `${dto.system}\n\n${dto.task}`);
  return EXIT_OK;
}
