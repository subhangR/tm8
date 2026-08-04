/**
 * The three environment variables the PTY host sets on a spawned agent
 * (04-EXECUTION-TRANSPLANT §1.1 — the spawn payload's envVars are preserved
 * verbatim from old maestro), plus one optional token.
 *
 *   TM8_SESSION_ID     the work_session entity id this process IS
 *   TM8_MANIFEST_PATH  absolute path to the JSON manifest SpawnService wrote
 *   TM8_BASE_URL       origin of the tm8-server that spawned it
 *   TM8_AGENT_TOKEN    optional, run-scoped bearer pinned to this agent persona
 *                      and work session; never a copy of the human credential
 *
 * Nothing here reads the repo or the cwd: a spawned agent runs from the
 * PROJECT's working directory, not from the tm8 checkout.
 */
export interface CliEnv {
  sessionId: string | undefined;
  manifestPath: string | undefined;
  baseUrl: string;
  agentToken: string | undefined;
}

export const DEFAULT_BASE_URL = 'http://127.0.0.1:4610';

export function readEnv(env: NodeJS.ProcessEnv = process.env): CliEnv {
  return {
    sessionId: env.TM8_SESSION_ID?.trim() || undefined,
    manifestPath: env.TM8_MANIFEST_PATH?.trim() || undefined,
    baseUrl: env.TM8_BASE_URL?.trim() || DEFAULT_BASE_URL,
    agentToken: env.TM8_AGENT_TOKEN?.trim() || undefined,
  };
}
