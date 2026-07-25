/**
 * `tm8 whoami` — the agent's (and the operator's) reachability check.
 *
 * It answers two questions at once: who does the server think is calling, and
 * is the server there at all. That second one is why it stays in the G1A verb
 * set — when a spawned terminal misbehaves, this is the first thing to run.
 *
 * The manifest's view of the persona is printed alongside the server's, since
 * they are composed by different code paths and a disagreement between them is
 * exactly the bug worth surfacing early.
 */
import { flagBool, type ParsedArgs } from '../args.js';
import { Tm8Client } from '../client.js';
import { readEnv } from '../env.js';
import { EXIT_OK } from '../exit.js';
import { readManifest, type Tm8Manifest } from '../manifest.js';
import { emit } from '../output.js';

export async function whoami(args: ParsedArgs): Promise<number> {
  const env = readEnv();

  let manifest: Tm8Manifest = {};
  if (env.manifestPath) {
    try {
      manifest = readManifest(env.manifestPath);
    } catch {
      // A missing manifest must not stop whoami — reachability is the point.
    }
  }

  const client = new Tm8Client({ baseUrl: env.baseUrl, token: env.agentToken });
  const identity = await client.invoke('identity.get');

  const payload = {
    server: env.baseUrl,
    sessionId: env.sessionId ?? manifest.sessionId ?? null,
    spaceId: manifest.spaceId ?? null,
    manifest: {
      name: manifest.agent?.name ?? null,
      teamMemberId: manifest.agent?.teamMemberId ?? null,
      mode: manifest.mode ?? null,
    },
    identity,
  };

  const name = manifest.agent?.name ?? '(unnamed agent)';
  const avatar = manifest.agent?.avatar ? `${manifest.agent.avatar} ` : '';
  const human = [
    `${avatar}${name}${manifest.agent?.role ? ` — ${manifest.agent.role}` : ''}`,
    `  server     ${env.baseUrl}`,
    `  session    ${payload.sessionId ?? '(none)'}`,
    `  space      ${payload.spaceId ?? '(none)'}`,
    `  identity   ${JSON.stringify(identity)}`,
  ].join('\n');

  emit(flagBool(args, 'json'), payload, human);
  return EXIT_OK;
}
