/**
 * The PER-SESSION home a space API key runs in (design 01a0cfa8 §4, A10).
 *
 * WHY A HOME AT ALL, when the key could ride in the environment alone. Measured
 * against the real CLIs (SC-2 PR body has the commands and request ids):
 *
 *   - codex 0.154.0 IGNORES `OPENAI_API_KEY` for its own model calls. With an
 *     empty `CODEX_HOME` and only the variable set, `codex exec` answers
 *     "401 Missing bearer or basic authentication". It sends a key only from
 *     `$CODEX_HOME/auth.json` (`{auth_mode:"apikey", OPENAI_API_KEY}`), which
 *     is what `codex login --with-api-key` writes, mode 0600.
 *   - claude 2.1.280 USES `ANTHROPIC_API_KEY`, but an empty `CLAUDE_CONFIG_DIR`
 *     parks an unattended PTY on the onboarding picker and then on "Detected a
 *     custom API key ... No (recommended)". `.claude.json` must already say
 *     `hasCompletedOnboarding` and list the key's last 20 characters under
 *     `customApiKeyResponses.approved`.
 *
 * So the home carries key material, and its lifecycle is split in two:
 *
 *   - THE SECRET (auth.json; the approved suffix) is written at spawn and at
 *     every resume from the CURRENT sealed key — a rekey applies at the next
 *     resume (D7) — and is scrubbed at PTY exit, on a kill, on a failed spawn,
 *     and by a boot sweep, since a crash skips the exit path.
 *   - THE STATE (codex rollouts under `sessions/`, claude transcripts under
 *     `projects/`) stays: resume reads the conversation back from this exact
 *     directory (`native-session.ts`, `claude --resume`), so removing it would
 *     make every space-key session unresumable. Whole-directory retention is
 *     session retention's question, as it is for member homes.
 *
 * Location: `<dataDir>/credentials/sessions/<workSessionId>/<provider>/`, every
 * level repaired to 0700 exactly as `agent-credential-home.ts` does. Never
 * under a space's login home, never in a worktree.
 *
 * Nothing here logs a path's contents, the key or the suffix (I5).
 */
import { randomUUID } from 'node:crypto';
import { chmod, mkdir, open, readdir, readFile, rename, rm } from 'node:fs/promises';
import { join } from 'node:path';

import type { AgentCredentialHome } from './agent-credentials.js';

const PRIVATE_DIRECTORY_MODE = 0o700;
const PRIVATE_FILE_MODE = 0o600;
const SESSION_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** Claude records an approved custom key by its last 20 characters. */
const CLAUDE_APPROVED_KEY_SUFFIX_LENGTH = 20;

export type SpaceApiKeyProvider = 'anthropic' | 'openai';

export function spaceSessionsRoot(dataDir: string): string {
  return join(dataDir, 'credentials', 'sessions');
}

export function spaceSessionHomeDir(dataDir: string, sessionId: string): string {
  if (!SESSION_ID_RE.test(sessionId)) throw new Error('work session id is not a uuid');
  return join(spaceSessionsRoot(dataDir), sessionId);
}

async function ensurePrivateDirectory(path: string): Promise<void> {
  await mkdir(path, { recursive: true, mode: PRIVATE_DIRECTORY_MODE });
  // `mode` is ignored for a directory that already exists; repair it.
  await chmod(path, PRIVATE_DIRECTORY_MODE);
}

/**
 * Write `content` to `path` atomically: a 0600 temp file in the SAME
 * directory, fsynced, then renamed over the target. A crash leaves either the
 * old file or the new one — never a truncated file that still holds a secret,
 * and never a missing `.claude.json` that breaks resume.
 */
async function writePrivateFileAtomic(path: string, content: string): Promise<void> {
  const temp = `${path}.${randomUUID()}.tmp`;
  const handle = await open(temp, 'wx', PRIVATE_FILE_MODE);
  try {
    await handle.writeFile(content);
    await handle.sync();
  } finally {
    await handle.close();
  }
  try {
    await rename(temp, path);
  } catch (error) {
    await rm(temp, { force: true });
    throw error;
  }
}

async function readJsonObject(path: string): Promise<Record<string, unknown> | null> {
  let raw: string;
  try {
    raw = await readFile(path, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
  try {
    const parsed: unknown = JSON.parse(raw);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    // A corrupt config holds nothing worth keeping; it is rewritten whole.
    return {};
  }
}

/**
 * Create (or re-seed, on resume) the per-session home for a space API key and
 * return it in the shape `composeEnv` consumes. Any surviving secret is
 * overwritten from `apiKey` — the key read NOW — never reused.
 */
export async function materializeSpaceApiKeyHome(input: {
  dataDir: string;
  sessionId: string;
  provider: SpaceApiKeyProvider;
  credentialId: string;
  apiKey: string;
}): Promise<AgentCredentialHome> {
  const credentialsDir = join(input.dataDir, 'credentials');
  const sessionsDir = spaceSessionsRoot(input.dataDir);
  const homeDir = spaceSessionHomeDir(input.dataDir, input.sessionId);
  const configDir = join(homeDir, input.provider);
  for (const dir of [credentialsDir, sessionsDir, homeDir, configDir]) {
    await ensurePrivateDirectory(dir);
  }

  if (input.provider === 'openai') {
    await writePrivateFileAtomic(
      join(configDir, 'auth.json'),
      `${JSON.stringify({ auth_mode: 'apikey', OPENAI_API_KEY: input.apiKey })}\n`,
    );
  } else {
    const path = join(configDir, '.claude.json');
    const existing = (await readJsonObject(path)) ?? {};
    await writePrivateFileAtomic(
      path,
      `${JSON.stringify({
        ...existing,
        hasCompletedOnboarding: true,
        customApiKeyResponses: {
          approved: [input.apiKey.slice(-CLAUDE_APPROVED_KEY_SUFFIX_LENGTH)],
          rejected: [],
        },
      }, null, 2)}\n`,
    );
  }

  return {
    provider: input.provider,
    homeDir,
    configDir,
    space: { credentialId: input.credentialId, apiKey: input.apiKey },
  };
}

/**
 * Remove every secret from one session's home, keeping its conversation state.
 * Idempotent; a session that never had a space home is a no-op. Throws only
 * on an unexpected filesystem error, which callers report without the path's
 * contents.
 */
export async function scrubSpaceSessionSecrets(dataDir: string, sessionId: string): Promise<boolean> {
  if (!SESSION_ID_RE.test(sessionId)) return false;
  const homeDir = spaceSessionHomeDir(dataDir, sessionId);
  let scrubbed = false;
  const authJson = join(homeDir, 'openai', 'auth.json');
  try {
    await rm(authJson);
    scrubbed = true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  const claudeJson = join(homeDir, 'anthropic', '.claude.json');
  const config = await readJsonObject(claudeJson);
  if (config && 'customApiKeyResponses' in config) {
    const { customApiKeyResponses: _dropped, ...rest } = config;
    await writePrivateFileAtomic(claudeJson, `${JSON.stringify(rest, null, 2)}\n`);
    scrubbed = true;
  }
  return scrubbed;
}

/**
 * The boot sweep: scrub every per-session home except those `isLive` names.
 * Returns the sessions it scrubbed and the ones it could not, by id only.
 */
export async function sweepSpaceSessionSecrets(
  dataDir: string,
  isLive: (sessionId: string) => boolean,
): Promise<{ scrubbed: string[]; errors: string[] }> {
  let entries: string[];
  try {
    entries = await readdir(spaceSessionsRoot(dataDir));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { scrubbed: [], errors: [] };
    throw error;
  }
  const scrubbed: string[] = [];
  const errors: string[] = [];
  for (const sessionId of entries) {
    if (!SESSION_ID_RE.test(sessionId) || isLive(sessionId)) continue;
    try {
      if (await scrubSpaceSessionSecrets(dataDir, sessionId)) scrubbed.push(sessionId);
    } catch {
      errors.push(sessionId);
    }
  }
  return { scrubbed, errors };
}
