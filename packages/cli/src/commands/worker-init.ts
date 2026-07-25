/**
 * `tm8 worker init` — the first thing a spawned agent runs.
 *
 * Reads TM8_MANIFEST_PATH, composes the system prompt, writes it to stdout.
 * It makes ZERO network calls: the server may still be finishing the spawn
 * transaction when the PTY starts, and an agent that cannot boot because a
 * status endpoint was slow is a worse failure than one that boots with a
 * slightly stale identity.
 */
import { flagBool, flagString, type ParsedArgs } from '../args.js';
import { readEnv } from '../env.js';
import { CliError, EXIT_OK, EXIT_USAGE } from '../exit.js';
import { readManifest } from '../manifest.js';
import { emit } from '../output.js';
import { composePrompt } from '../prompt.js';

export function workerInit(args: ParsedArgs): number {
  const env = readEnv();
  const manifestPath = flagString(args, 'manifest') ?? env.manifestPath;

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

  emit(flagBool(args, 'json'), envelope, `${envelope.system}\n\n${envelope.task}`);
  return EXIT_OK;
}
