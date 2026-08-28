/**
 * Cloning a member's own GitHub repository into a server-chosen directory.
 *
 * This module exists to make `projects.createFromRepo` safe, and every choice
 * in it is load-bearing for that. Two rules govern the whole file:
 *
 *  1. THE CALLER NEVER NAMES A PATH. `projects.create` is node-admin-only
 *     precisely because it accepts an arbitrary absolute `workingDir`, and a
 *     project row is a read grant: `projects.files.list` is member-reachable
 *     and scoped to the working directory, so a project pointed at `/` hands
 *     every readable file on the node to everyone in the space. Here the
 *     directory is DERIVED — managed root, then space id, then a slug of the
 *     repository — so there is no path for a caller to influence and no
 *     reason to demand node-admin. See migration 173.
 *
 *  2. THE TOKEN NEVER BECOMES AN ARGUMENT OR A URL. It is passed only in the
 *     child environment and read by a git credential helper, the same
 *     mechanism `manifest.ts` uses for spawned sessions. A token embedded in
 *     a remote URL would persist in `.git/config` inside the clone, which is
 *     then readable through `projects.files.list` by the whole space.
 */
import { execFile } from 'node:child_process';
import { mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';

import { CollabError } from '@tm8/contract';

const execFileAsync = promisify(execFile);

/** A clone of a large repository over a slow link should still finish. */
const CLONE_TIMEOUT_MS = 300_000;

/**
 * Byte-for-byte the helper from `packages/execution/src/spawn/manifest.ts`.
 * The string itself holds no secret: git expands `$GH_TOKEN` only inside the
 * child environment, and only when it actually asks for a credential.
 */
const GIT_CREDENTIAL_HELPER =
  '!f() { test "$1" = get && printf '
  + '"username=%s\\npassword=%s\\n" "${TM8_GIT_LOGIN:-x-access-token}" "$GH_TOKEN"; }; f';

/** Owner and repository segments GitHub itself accepts. */
const SEGMENT = /^[A-Za-z0-9._-]+$/;

export interface NormalizedRepo {
  /** The canonical HTTPS clone URL. Never carries credentials. */
  url: string;
  owner: string;
  repo: string;
}

/**
 * Accept the shapes a person actually pastes, and nothing else.
 *
 * The rejections are the point. `file://` and a bare local path would clone
 * any repository already on the node — including another space's project —
 * into a directory the requesting space can then read. `ssh://` and
 * `git@host:` would authenticate as the NODE's key rather than as the member,
 * which is the impersonation this whole feature is built to avoid. Any host
 * other than github.com is refused because the stored credential is a GitHub
 * credential and would be presented to whatever host was named.
 */
export function normalizeGitHubRepoUrl(raw: string): NormalizedRepo {
  const trimmed = raw.trim().replace(/\.git$/i, '').replace(/\/+$/, '');
  if (trimmed === '') {
    throw new CollabError('invalid_input', 'repoUrl is required');
  }

  let path: string;
  if (/^https:\/\//i.test(trimmed)) {
    let parsed: URL;
    try {
      parsed = new URL(trimmed);
    } catch {
      throw new CollabError('invalid_input', `not a valid repository URL: ${trimmed}`);
    }
    if (parsed.hostname.toLowerCase() !== 'github.com') {
      throw new CollabError(
        'invalid_input',
        `only github.com repositories can be linked, got ${parsed.hostname}`,
      );
    }
    // A URL carrying its own credentials must not be laundered into a project.
    if (parsed.username !== '' || parsed.password !== '') {
      throw new CollabError('invalid_input', 'repoUrl must not embed credentials');
    }
    path = parsed.pathname.replace(/^\/+/, '');
  } else if (/^(github\.com\/)/i.test(trimmed)) {
    path = trimmed.slice('github.com/'.length);
  } else if (/^[^/\s]+\/[^/\s]+$/.test(trimmed)) {
    path = trimmed;
  } else {
    throw new CollabError(
      'invalid_input',
      'repoUrl must be an https://github.com/owner/repo URL or owner/repo',
    );
  }

  const segments = path.split('/').filter((segment) => segment !== '');
  if (segments.length !== 2) {
    throw new CollabError('invalid_input', 'repoUrl must name exactly one owner and one repository');
  }
  const [owner, repo] = segments as [string, string];
  for (const segment of [owner, repo]) {
    if (!SEGMENT.test(segment) || segment === '.' || segment === '..') {
      throw new CollabError('invalid_input', `not a valid repository path segment: ${segment}`);
    }
  }

  return { url: `https://github.com/${owner}/${repo}.git`, owner, repo };
}

/**
 * The one directory tree self-serve clones may occupy.
 *
 * Deliberately NOT `TM8_PROJECT_ROOTS`. Those are the BROWSE roots, they
 * default to the whole filesystem, and they are the scope a node admin picks
 * from by hand. Self-serve clones get their own root so that widening the
 * browse scope never widens what an unprivileged flow can write.
 */
export function selfServeProjectRoot(dataDir: string): string {
  return process.env.TM8_SELF_SERVE_PROJECT_ROOT?.trim() || join(dataDir, 'projects');
}

/** The derived, caller-uninfluenced destination for one space's copy of a repo. */
export function projectWorkingDir(dataDir: string, spaceId: string, repo: NormalizedRepo): string {
  // `spaceId` is a uuid validated upstream and both segments matched SEGMENT,
  // so no component can contain a separator or a dot-dot.
  return join(selfServeProjectRoot(dataDir), spaceId, `${repo.owner}-${repo.repo}`);
}

/**
 * Strip a secret from anything on its way to a caller or a log.
 *
 * git should never echo the token — it arrives through a credential helper,
 * not the command line — but "should never" is not a guarantee worth betting
 * a credential on, and clone failures are exactly when stderr gets surfaced.
 */
export function redactToken(text: string, token: string): string {
  return token === '' ? text : text.split(token).join('[redacted]');
}

export interface CloneOptions {
  repo: NormalizedRepo;
  workingDir: string;
  token: string;
  /** The GitHub login the token belongs to; git uses it as the username. */
  login: string;
  /** Injected by tests. */
  run?: typeof execFileAsync;
}

/**
 * Clone `repo` into `workingDir` as the credential's owner.
 *
 * On any failure the partial directory is removed. Leaving it behind would
 * both strand the unique `projects.working_dir` slot and leave a half tree
 * that a retry would then refuse to clone into.
 */
export async function cloneRepository(options: CloneOptions): Promise<void> {
  const { repo, workingDir, token, login } = options;
  const run = options.run ?? execFileAsync;

  // The managed root may not exist yet, or may not be writable by the server
  // user. Both are deployment faults, and both must read as one rather than
  // escaping as a raw ENOENT/EACCES from deep inside a command handler.
  try {
    await mkdir(join(workingDir, '..'), { recursive: true });
  } catch (error) {
    throw new CollabError(
      'upstream_unavailable',
      `self-serve project root is not writable: ${(error as NodeJS.ErrnoException).code ?? 'unknown'}`,
    );
  }

  try {
    await run(
      'git',
      [
        '-c', 'core.hooksPath=/dev/null',
        '-c', 'core.fsmonitor=false',
        'clone', '--', repo.url, workingDir,
      ],
      {
        encoding: 'utf8',
        timeout: CLONE_TIMEOUT_MS,
        env: {
          PATH: process.env.PATH ?? '/usr/bin:/bin',
          HOME: process.env.HOME ?? '/tmp',
          // The credential path: helper reads these two, nothing else does.
          GH_TOKEN: token,
          TM8_GIT_LOGIN: login,
          // Never fall back to a machine-wide helper or an interactive prompt;
          // a wrong or missing token must fail, not silently authenticate as
          // the node.
          GIT_TERMINAL_PROMPT: '0',
          GIT_CONFIG_COUNT: '2',
          GIT_CONFIG_KEY_0: 'credential.https://github.com.helper',
          GIT_CONFIG_VALUE_0: '',
          GIT_CONFIG_KEY_1: 'credential.https://github.com.helper',
          GIT_CONFIG_VALUE_1: GIT_CREDENTIAL_HELPER,
        },
      },
    );
  } catch (error) {
    await rm(workingDir, { recursive: true, force: true }).catch(() => undefined);

    // Classify on the RAW text and redact only what is surfaced. Redacting
    // first corrupts the thing being matched: `redactToken` is a plain
    // substring replace, so a token that happens to occur inside an ordinary
    // word rewrites git's wording and the classification silently degrades to
    // the generic branch.
    const raw = String((error as { stderr?: unknown }).stderr ?? (error as Error).message ?? '');
    const stderr = redactToken(raw, token);
    // Authentication and existence are indistinguishable to git on a private
    // repository, and GitHub returns the same 404 either way. Say so rather
    // than guessing, because the two fixes are different.
    if (/Authentication failed|could not read Username|not found|Repository not found/i.test(raw)) {
      throw new CollabError(
        'forbidden',
        `could not read ${repo.owner}/${repo.repo} as ${login} — check the repository exists `
        + 'and that your GitHub credential grants access to it',
        { details: { reason: 'repo_unreadable' } },
      );
    }
    if ((error as { killed?: boolean }).killed === true) {
      throw new CollabError('upstream_unavailable', `cloning ${repo.owner}/${repo.repo} timed out`);
    }
    throw new CollabError(
      'upstream_unavailable',
      `could not clone ${repo.owner}/${repo.repo}: ${stderr.slice(0, 500)}`,
    );
  }
}
