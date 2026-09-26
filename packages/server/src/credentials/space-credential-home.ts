/**
 * A login-shaped space credential's file home (design §3, SC-4):
 *
 *   <dataDir>/credentials/spaces/<spaceId>/<credentialId>/            HOME of every spawn on it
 *   <dataDir>/credentials/spaces/<spaceId>/<credentialId>/<provider>/ CLAUDE_CONFIG_DIR / CODEX_HOME
 *   <dataDir>/credentials/spaces/<spaceId>/<credentialId>/.login/<ws>/ one login terminal's staging HOME
 *
 * SHARED, NOT COPIED PER SESSION — decided from a measurement, not assumed
 * (the PR body carries the table). N parallel `claude` sessions sharing one
 * `.credentials.json` refreshed once and all succeeded: Claude serialises its
 * refresh behind a lockfile in the config dir and re-reads before it writes.
 * N parallel `codex` sessions sharing one `auth.json` all succeeded too:
 * losers of the refresh race re-read the file and adopt the winner's token.
 * A private copy per session was STRICTLY WORSE for both — every copy but one
 * spent a single-use refresh token the winner had already rotated — and a
 * locked write-back cannot help, because the collision is the refresh request
 * itself, not the write that follows it.
 *
 * WHY A LOGIN WRITES TO A STAGING DIRECTORY AND NOT TO THE LIVE ONE (A6). A
 * re-login runs while agents spawned on the same credential read the live
 * home. A vendor CLI that logs out first, or writes its file in place, or is
 * abandoned half way, would leave those agents with a missing or partial file,
 * or with no login at all after an abandoned attempt. So the terminal logs in
 * under `.login/<ws>/`, and only a login the PROBE confirmed AND
 * `finish_space_credential_login(ws, true)` committed is promoted: file by
 * file, each written to a temp name at 0600 and `rename`d over the live one.
 * A reader sees the old file or the new one, never neither and never half.
 *
 * WHY EVERY PATH SEGMENT IS ALLOWLISTED. The ids come from the database and are
 * uuids, and this check will not fire; it is what makes "a uuid" a property
 * of this function rather than of its callers, on a path under which secrets
 * are written. Every level is repaired to 0700 exactly as
 * `agent-credential-home.ts` explains, and a symlink at any level is refused.
 */
import { randomUUID } from 'node:crypto';
import { chmod, lstat, mkdir, open, readdir, readFile, realpath, rename, rm, unlink } from 'node:fs/promises';
import { basename, join, sep } from 'node:path';

import { CollabError } from '@tm8/contract';
import { extractCodexRolloutIdentity } from '@tm8/execution';

import { CREDENTIAL_DIRECTORY_MODE, credentialsRoot } from './agent-credential-home.js';

/** The providers a space LOGIN exists for (206's start_space_credential_login). */
export const SPACE_LOGIN_PROVIDERS = ['anthropic', 'openai'] as const;
export type SpaceLoginProvider = (typeof SPACE_LOGIN_PROVIDERS)[number];

/** Directory names under `<dataDir>/credentials` that are not identity homes. */
export const SPACE_CREDENTIAL_ROOT_NAME = 'spaces';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const FILE_MODE = 0o600;

/**
 * What a completed login leaves in the config dir, per provider. `required`
 * is the credential itself — a probe that answered "connected" without it
 * read something other than the staging home, and nothing is promoted.
 * `merged` is Claude's state file: agents rewrite it constantly (projects,
 * history), so the login's account keys are merged into the live one rather
 * than the whole file replaced.
 */
const LOGIN_FILES: Record<SpaceLoginProvider, { required: string; merged?: { file: string; keys: string[] } }> = {
  anthropic: {
    required: '.credentials.json',
    merged: { file: '.claude.json', keys: ['oauthAccount', 'hasCompletedOnboarding'] },
  },
  openai: { required: 'auth.json' },
};

/**
 * Every file a CLI needs to stay logged in, per provider: the login itself and
 * the state file it merges into. The narrow scrub never deletes one of these;
 * its targets are `*.jsonl` transcripts, so this is an assertion, not a filter.
 */
const LOGIN_AUTH_FILES: ReadonlySet<string> = new Set(
  Object.values(LOGIN_FILES).flatMap((files) => [files.required, ...(files.merged ? [files.merged.file] : [])]),
);

/** How much of a codex rollout head proves ownership (as native-session.ts reads). */
const ROLLOUT_HEAD_BYTES = 256 * 1024;

/** One non-owner launch the scrub may remove the transcript of. */
export interface SpaceLoginForeignLaunch {
  workSessionId: string;
  /** Claude's `--session-id` (tm8's own id); unused for codex. */
  nativeSessionId: string | null;
}

export interface SpaceLoginHomeKey {
  spaceId: string;
  credentialId: string;
  provider: SpaceLoginProvider;
}

export interface SpaceLoginStaging {
  /** The login terminal's HOME. */
  homeDir: string;
  /** Its CLAUDE_CONFIG_DIR / CODEX_HOME. */
  configDir: string;
}

function assertUuid(value: string, what: string): void {
  // Canonical lowercase only: the same credential must never have two homes.
  if (!UUID_RE.test(value)) {
    throw new CollabError('invariant_violation', `${what} is not usable as a credential home path`);
  }
}

export function assertSpaceLoginProvider(provider: string): asserts provider is SpaceLoginProvider {
  if (!(SPACE_LOGIN_PROVIDERS as readonly string[]).includes(provider)) {
    throw new CollabError('invalid_input', `a space login exists only for ${SPACE_LOGIN_PROVIDERS.join(' and ')}`);
  }
}

function spacesRoot(dataDir: string): string {
  return join(credentialsRoot(dataDir), SPACE_CREDENTIAL_ROOT_NAME);
}

/** `<dataDir>/credentials/spaces/<spaceId>/<credentialId>` — validated. */
export function spaceLoginCredentialDir(dataDir: string, spaceId: string, credentialId: string): string {
  assertUuid(spaceId, 'space id');
  assertUuid(credentialId, 'credential id');
  return join(spacesRoot(dataDir), spaceId, credentialId);
}

/** The live config dir every spawn on the credential reads. */
export function spaceLoginConfigDir(dataDir: string, key: SpaceLoginHomeKey): string {
  assertSpaceLoginProvider(key.provider);
  return join(spaceLoginCredentialDir(dataDir, key.spaceId, key.credentialId), key.provider);
}

function stagingHomeDir(dataDir: string, key: SpaceLoginHomeKey, workSessionId: string): string {
  assertUuid(workSessionId, 'work session id');
  return join(spaceLoginCredentialDir(dataDir, key.spaceId, key.credentialId), '.login', workSessionId);
}

/** Create-or-repair one directory at 0700, refusing a symlink or a file. */
async function ensurePrivateDirectory(path: string): Promise<void> {
  await mkdir(path, { recursive: true, mode: CREDENTIAL_DIRECTORY_MODE });
  const info = await lstat(path);
  if (!info.isDirectory()) {
    throw new CollabError('invariant_violation', 'a space credential home path is not a directory');
  }
  await chmod(path, CREDENTIAL_DIRECTORY_MODE);
}

/** Every level from `<dataDir>/credentials` down to `leaf`, in order. */
async function ensureLevels(dataDir: string, levels: string[]): Promise<void> {
  let path = credentialsRoot(dataDir);
  await ensurePrivateDirectory(path);
  for (const level of levels) {
    path = join(path, level);
    // Sequential: a child repaired while its parent is being created can be
    // left at the umask default.
    await ensurePrivateDirectory(path);
  }
}

async function readIfPresent(path: string): Promise<Buffer | null> {
  try {
    const info = await lstat(path);
    // A symlink planted in a home is never followed into a read or a promote.
    if (!info.isFile()) return null;
    return await readFile(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}

/** temp 'wx' at 0600 + fsync + rename: a reader sees the old file or the new one. */
async function writePrivateFileAtomic(path: string, bytes: Buffer | string): Promise<void> {
  const temp = `${path}.${randomUUID()}.tmp`;
  const handle = await open(temp, 'wx', FILE_MODE);
  try {
    await handle.writeFile(bytes);
    await handle.sync();
  } finally {
    await handle.close();
  }
  try {
    await rename(temp, path);
  } catch (error) {
    await unlink(temp).catch(() => undefined);
    throw error;
  }
}

export class SpaceLoginHomes {
  private readonly dataDir: string;
  /** Per-credential serialisation of promote and remove. */
  private readonly locks = new Map<string, Promise<void>>();

  constructor(options: { dataDir: string }) {
    this.dataDir = options.dataDir;
  }

  /** The live home, repaired to 0700 at every level. */
  async ensureLive(key: SpaceLoginHomeKey): Promise<SpaceLoginStaging> {
    const configDir = spaceLoginConfigDir(this.dataDir, key);
    await ensureLevels(this.dataDir, [SPACE_CREDENTIAL_ROOT_NAME, key.spaceId, key.credentialId, key.provider]);
    return { homeDir: spaceLoginCredentialDir(this.dataDir, key.spaceId, key.credentialId), configDir };
  }

  /** A login terminal's own HOME and config dir, empty and 0700. */
  async ensureStaging(key: SpaceLoginHomeKey, workSessionId: string): Promise<SpaceLoginStaging> {
    const homeDir = stagingHomeDir(this.dataDir, key, workSessionId);
    await ensureLevels(this.dataDir, [
      SPACE_CREDENTIAL_ROOT_NAME,
      key.spaceId,
      key.credentialId,
      '.login',
      workSessionId,
      key.provider,
    ]);
    return { homeDir, configDir: join(homeDir, key.provider) };
  }

  /** Whether the staging config dir holds the provider's credential file. */
  async stagingHasLogin(key: SpaceLoginHomeKey, workSessionId: string): Promise<boolean> {
    const configDir = join(stagingHomeDir(this.dataDir, key, workSessionId), key.provider);
    return (await readIfPresent(join(configDir, LOGIN_FILES[key.provider].required))) !== null;
  }

  /**
   * Move a probed, committed login into the live home (A6).
   *
   * `stillWanted` is re-asked UNDER the per-credential lock, after any
   * in-flight remove has finished: a delete that revoked the credential
   * between the finish RPC and this call must not have its home re-created
   * by a promote that lost the race (M6). It answers from the DB row.
   * Returns false when nothing was promoted.
   */
  async promote(
    key: SpaceLoginHomeKey,
    workSessionId: string,
    stillWanted: () => Promise<boolean>,
  ): Promise<boolean> {
    assertSpaceLoginProvider(key.provider);
    return this.withLock(key.credentialId, async () => {
      if (!(await stillWanted())) return false;
      const stagingConfig = join(stagingHomeDir(this.dataDir, key, workSessionId), key.provider);
      const files = LOGIN_FILES[key.provider];
      const credential = await readIfPresent(join(stagingConfig, files.required));
      if (credential === null) return false;

      const { configDir } = await this.ensureLive(key);
      await writePrivateFileAtomic(join(configDir, files.required), credential);

      if (files.merged) {
        const staged = await readIfPresent(join(stagingConfig, files.merged.file));
        if (staged !== null) {
          const livePath = join(configDir, files.merged.file);
          const live = await readIfPresent(livePath);
          await writePrivateFileAtomic(livePath, mergeState(live, staged, files.merged.keys));
        }
      }
      return true;
    });
  }

  /** Remove one login terminal's staging HOME. Idempotent. */
  async removeStaging(key: SpaceLoginHomeKey, workSessionId: string): Promise<void> {
    await rm(stagingHomeDir(this.dataDir, key, workSessionId), { recursive: true, force: true });
  }

  /**
   * Remove the credential's whole home, staging included (delete's last step,
   * and a new login that never finished). Serialised with `promote`.
   */
  async remove(key: { spaceId: string; credentialId: string }): Promise<void> {
    const dir = spaceLoginCredentialDir(this.dataDir, key.spaceId, key.credentialId);
    await this.withLock(key.credentialId, async () => {
      await rm(dir, { recursive: true, force: true });
    });
  }

  /**
   * The narrow scrub (lead ruling on R1/R17): after a switch to private,
   * remove the transcripts of NON-OWNER launches from the shared live config
   * dir and nothing else. The home stays — it is the only store of the login.
   *
   * Only files the repo's own resume code identifies with one session:
   *   - claude: `<config>/projects/<dir>/<nativeSessionId>.jsonl`, the file
   *     `--session-id` writes and `ClaudeHeadlessAdapter` resumes from;
   *   - codex: a rollout under `<config>/sessions/` whose USER message carries
   *     the session's `<tm8_session_id>` marker (`extractCodexRolloutIdentity`,
   *     the proof resume uses; a mention elsewhere in the file does not count).
   * Anything not attributable stays: history, caches, the owner's transcripts
   * in the same directories. Symlinks are never followed, every target must
   * resolve under the config dir, and an auth file is never a target.
   * Serialised with `promote` and `remove`. Returns how many files went.
   */
  async scrubForeignLaunches(
    key: SpaceLoginHomeKey,
    launches: readonly SpaceLoginForeignLaunch[],
  ): Promise<number> {
    assertSpaceLoginProvider(key.provider);
    const configDir = spaceLoginConfigDir(this.dataDir, key);
    return this.withLock(key.credentialId, async () => {
      const root = await realDirectory(configDir);
      if (root === null || launches.length === 0) return 0;
      let removed = 0;
      const drop = async (path: string): Promise<void> => {
        if (!(await isContainedFile(root, path))) return;
        if (LOGIN_AUTH_FILES.has(basename(path))) {
          throw new CollabError('invariant_violation', 'the login-home scrub reached an auth file');
        }
        await unlink(path);
        removed += 1;
      };

      if (key.provider === 'anthropic') {
        const ids = launches
          .map((launch) => launch.nativeSessionId)
          .filter((id): id is string => id !== null && UUID_RE.test(id));
        const projects = join(root, 'projects');
        for (const dir of await directoriesIn(projects)) {
          for (const id of ids) await drop(join(projects, dir, `${id}.jsonl`));
        }
        return removed;
      }

      const ids = launches.map((launch) => launch.workSessionId).filter((id) => UUID_RE.test(id));
      const sessions = join(root, 'sessions');
      let entries: string[];
      try {
        entries = await readdir(sessions, { recursive: true });
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return removed;
        throw error;
      }
      for (const entry of entries) {
        if (!entry.endsWith('.jsonl')) continue;
        const path = join(sessions, entry);
        if (!(await isContainedFile(root, path))) continue;
        const head = await readHead(path, ROLLOUT_HEAD_BYTES);
        if (head === null) continue;
        if (ids.some((id) => extractCodexRolloutIdentity(head, id) !== null)) await drop(path);
      }
      return removed;
    });
  }

  private async withLock<T>(credentialId: string, run: () => Promise<T>): Promise<T> {
    const previous = this.locks.get(credentialId) ?? Promise.resolve();
    let release!: () => void;
    const mine = new Promise<void>((resolve) => {
      release = resolve;
    });
    const tail = previous.then(() => mine);
    this.locks.set(credentialId, tail);
    await previous;
    try {
      return await run();
    } finally {
      release();
      if (this.locks.get(credentialId) === tail) this.locks.delete(credentialId);
    }
  }
}

/** The real path of a directory that is not itself a symlink, or null. */
async function realDirectory(path: string): Promise<string | null> {
  try {
    const info = await lstat(path);
    return info.isDirectory() ? await realpath(path) : null;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}

/** Plain subdirectories of `path` (no symlinks); none when it is absent. */
async function directoriesIn(path: string): Promise<string[]> {
  try {
    const entries = await readdir(path, { withFileTypes: true });
    return entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
}

/** A regular file (never a symlink) whose real path lies under `root`. */
async function isContainedFile(root: string, path: string): Promise<boolean> {
  try {
    if (!(await lstat(path)).isFile()) return false;
    return (await realpath(path)).startsWith(`${root}${sep}`);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
}

async function readHead(path: string, bytes: number): Promise<string | null> {
  try {
    const handle = await open(path, 'r');
    try {
      const buffer = Buffer.alloc(bytes);
      const { bytesRead } = await handle.read(buffer, 0, bytes, 0);
      return buffer.subarray(0, bytesRead).toString('utf8');
    } finally {
      await handle.close();
    }
  } catch {
    return null;
  }
}

/**
 * Claude's `.claude.json`: the live file keeps everything agents wrote to it;
 * the login contributes only its account keys. An unparseable live file is
 * replaced by the staged one rather than failing the promote — the
 * credential is `.credentials.json`, already in place by now.
 */
function mergeState(live: Buffer | null, staged: Buffer, keys: string[]): string | Buffer {
  let stagedJson: Record<string, unknown>;
  try {
    stagedJson = JSON.parse(staged.toString('utf8')) as Record<string, unknown>;
  } catch {
    return live ?? staged;
  }
  if (live === null) return staged;
  let liveJson: Record<string, unknown>;
  try {
    liveJson = JSON.parse(live.toString('utf8')) as Record<string, unknown>;
  } catch {
    return staged;
  }
  for (const key of keys) {
    if (key in stagedJson) liveJson[key] = stagedJson[key];
  }
  return `${JSON.stringify(liveJson, null, 2)}\n`;
}
