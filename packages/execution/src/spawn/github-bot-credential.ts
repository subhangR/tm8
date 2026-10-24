/**
 * THE NODE'S SHARED GITHUB BOT CREDENTIAL — one token for every session on
 * this node, and no personal login anywhere behind it.
 *
 * WHY THIS EXISTS. On a SHARED server, `credential-resolution.ts`'s auto chain
 * for GitHub reads the launcher's own rung first (`my_default`, then the
 * member row). That is correct on a laptop, where the launcher and the machine
 * are the same person. On a box several people launch sessions on it means
 * every session authenticates to GitHub as whichever human happens to have
 * connected a login — their pushes, their rate limit, their repo reach, their
 * blast radius if the session misbehaves. It is also invisible: nothing in the
 * session's own view says whose identity it is holding.
 *
 * So a node operator can declare, in the SERVER's own configuration, that
 * GitHub on this node is a BOT: one credential, named once, used by every
 * session, with the personal rungs not merely deprioritised but UNREACHABLE.
 *
 * THE POSTURE IS ONE VARIABLE, AND THAT IS DELIBERATE.
 * `TM8_GITHUB_BOT_CREDENTIAL_FILE` set and non-empty IS the posture. There is
 * no second "enabled" flag to disagree with it, no DB row that can drift from
 * it, and no inline-token alternative: a second way to configure the same
 * credential is a second thing to audit, and the one that is quietly empty is
 * the one that re-opens the member rung. The login travels in the SAME FILE as
 * the token for the same reason — two variables can disagree about who the bot
 * is, one file cannot.
 *
 * EVERY FAILURE THROWS; NONE RETURNS NULL. This is the whole security property
 * and it is worth being blunt about. `null` from this module means "the
 * operator did not ask for a bot posture", and `credential-resolution.ts`
 * answers it by running the ordinary chain — whose first rung is a personal
 * login. So a missing file, a bad mode, malformed JSON or an empty token MUST
 * NOT be reported as `null`: that would turn every operator typo into a silent
 * downgrade to exactly the identity the posture exists to remove. They throw,
 * the launch refuses, and the operator reads a sentence naming the file.
 *
 * THE MODE CHECK IS NOT CEREMONY. The file holds a bearer token for an account
 * with write access to real repositories, and it sits on a box whose sessions
 * can read any path their agent can reach. `0600`/`0400` is what makes
 * "sessions cannot read each other's credentials" true of this one too, and a
 * `0644` drop by a well-meaning `scp` is precisely the mistake that leaves the
 * posture looking healthy while the token is world-readable. Refusing on the
 * mode makes that a startup-visible failure instead of a quiet one.
 *
 * THE FILE IS RE-READ ON EVERY SPAWN, not cached at construction. Rotating the
 * bot token is then `install -m 600` a new file and nothing else — no restart,
 * which matters because restarting this server is the operation most likely to
 * disturb live sessions. The cost is one small read per spawn, against a spawn
 * that already does several.
 *
 * WHAT THIS MODULE DOES NOT DO. It does not scope the token. Least privilege
 * for a GitHub PAT lives at GitHub — a fine-grained token limited to the
 * repositories it needs, with no admin and no release rights — and no check
 * here could enforce it, because the token's reach is not derivable from its
 * text. Pretending otherwise with a repo allowlist in this file would read like
 * a guarantee while being advice. The runbook states the scoping; GitHub holds
 * it.
 */
import { readFile, stat } from 'node:fs/promises';

import { SpawnError, type GitHubCredential } from './types.js';

/**
 * The one variable. Its VALUE is a path; its PRESENCE is the posture.
 *
 * Exported so the config registry and the tests name the same constant rather
 * than each spelling the string — a knob whose name exists in three string
 * literals is a knob that gets renamed in two of them.
 */
export const GITHUB_BOT_CREDENTIAL_FILE_ENV = 'TM8_GITHUB_BOT_CREDENTIAL_FILE';

/** Bytes. A PAT is ~100 bytes; this is a "someone pointed it at a log" guard. */
const MAX_FILE_BYTES = 8_000;

/** Is the shared-bot posture configured on this node? */
export function gitHubBotPostureActive(env: NodeJS.ProcessEnv = process.env): boolean {
  return (env[GITHUB_BOT_CREDENTIAL_FILE_ENV]?.trim() ?? '') !== '';
}

/** The configured path, or null when the posture is off. */
export function gitHubBotCredentialPath(env: NodeJS.ProcessEnv = process.env): string | null {
  const path = env[GITHUB_BOT_CREDENTIAL_FILE_ENV]?.trim();
  return path === undefined || path === '' ? null : path;
}

/**
 * A refusal that names the file and the fix, and never the token.
 *
 * `cause` carries only the reason — not the file's bytes, not a prefix of
 * them, and not the parse error's message, because a JSON parse error quotes
 * the input it choked on and the input here is a secret.
 */
function refuse(path: string, problem: string, fix: string): SpawnError {
  return new SpawnError(
    `this node runs GitHub on a shared bot credential (${GITHUB_BOT_CREDENTIAL_FILE_ENV}), but ` +
      `${path} ${problem} — ${fix}. No session runs on a personal GitHub login on this node, so ` +
      'the launch is refused rather than started without git',
    'internal',
    { provider: 'github', reason: 'bot_credential_unusable', path },
  );
}

/**
 * Read the node's shared GitHub bot credential.
 *
 * `null` means ONLY that the operator configured no posture. Every other
 * outcome throws — see the header; this is the one contract in this file that
 * a caller must not soften.
 */
export async function readGitHubBotCredential(
  env: NodeJS.ProcessEnv = process.env,
): Promise<GitHubCredential | null> {
  const path = gitHubBotCredentialPath(env);
  if (path === null) return null;

  let mode: number;
  let size: number;
  try {
    const info = await stat(path);
    if (!info.isFile()) {
      throw refuse(path, 'is not a regular file', `point ${GITHUB_BOT_CREDENTIAL_FILE_ENV} at the credential file`);
    }
    mode = info.mode;
    size = info.size;
  } catch (error) {
    if (error instanceof SpawnError) throw error;
    throw refuse(
      path,
      'could not be read',
      'create it (owner-only, mode 600) or correct the path; see docs/ops/GITHUB-BOT-CREDENTIAL.md',
    );
  }

  // Owner-only. The group and other bits are the whole test: a token a second
  // unix account can read is not a credential this node can claim to isolate.
  if ((mode & 0o077) !== 0) {
    throw refuse(
      path,
      `is readable beyond its owner (mode ${(mode & 0o777).toString(8).padStart(3, '0')})`,
      'run `chmod 600` on it',
    );
  }
  if (size > MAX_FILE_BYTES) {
    throw refuse(path, `is ${size} bytes, far larger than a credential file`, 'check the path points at the credential, not a log');
  }

  let raw: string;
  try {
    raw = await readFile(path, 'utf8');
  } catch {
    throw refuse(path, 'could not be read', 'check its ownership and that this server runs as its owner');
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    // Deliberately not the parser's message: it quotes the input.
    throw refuse(path, 'is not valid JSON', 'write it as {"login":"<bot-login>","token":"<token>"}');
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw refuse(path, 'is not a JSON object', 'write it as {"login":"<bot-login>","token":"<token>"}');
  }

  const record = parsed as Record<string, unknown>;
  const login = typeof record['login'] === 'string' ? record['login'].trim() : '';
  const token = typeof record['token'] === 'string' ? record['token'].trim() : '';
  if (login === '') {
    throw refuse(path, 'has no "login"', "set it to the bot account's GitHub login, so commits are attributed to the bot");
  }
  if (token === '') {
    throw refuse(path, 'has no "token"', 'set it to the bot account\'s fine-grained token');
  }

  return { provider: 'github', login, token };
}
