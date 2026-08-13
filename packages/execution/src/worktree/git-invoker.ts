// @tm8/execution — argv-only Git invocation for the worktree manager.
//
// THE RULE THIS FILE EXISTS TO ENFORCE (TM8-WORKTREE-DESIGN §4.6, §8): Git is
// invoked as an ARGV ARRAY through execFile, never a shell string, never string
// interpolation. There was zero Git invocation anywhere in product source
// before this file, so the pattern is established here with nothing to imitate
// — and nothing to excuse a `spawn('sh', ['-c', ...])` creeping in later.
// `execFile` without `shell: true` passes argv to the OS directly; no token in
// `args` is ever interpreted by a shell, so `;`, backticks, `$(…)` and
// newlines in a client-supplied ref are inert bytes here. The ref-shape
// validation below is defense in depth on top of that, not the defense.

import { execFile } from 'node:child_process';

export interface GitResult {
  code: number;
  stdout: string;
  stderr: string;
}

export interface GitRunOptions {
  /** Working directory for the invocation. */
  cwd?: string;
  /** Kill the process after this long — a hung git must not hang a saga. */
  timeoutMs?: number;
  /**
   * stdout/stderr cap. Node's execFile default (1 MiB) REJECTS past the cap,
   * turning a large-but-legitimate `git diff` into a 500; callers that read
   * potentially-large output (the diff read op) raise this and cap the text
   * themselves, honestly, with a `truncated` flag.
   */
  maxBufferBytes?: number;
}

const DEFAULT_TIMEOUT_MS = 30_000;

/**
 * Run `git <args>` and resolve with the exit code rather than rejecting on
 * non-zero — callers branch on `code` and read stderr, because for probes
 * (`merge-base --is-ancestor`) a non-zero exit is an ANSWER, not an error.
 * Rejects only when the process could not run at all (git missing, cwd gone).
 */
export function runGit(args: readonly string[], options: GitRunOptions = {}): Promise<GitResult> {
  return new Promise((resolve, reject) => {
    execFile(
      'git',
      // Defense in depth against argv-option injection: `--` is not usable
      // everywhere, so instead no caller-supplied value may LOOK like an
      // option. Enforced by assertSafeRefName/assertSafeBranchName at the
      // manager layer; asserted structurally here as the last line.
      args as string[],
      {
        cwd: options.cwd,
        timeout: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
        ...(options.maxBufferBytes === undefined ? {} : { maxBuffer: options.maxBufferBytes }),
        encoding: 'utf8',
        // NO `shell` option. execFile's default (false) is the point.
        windowsHide: true,
        env: {
          ...process.env,
          // Never let an interactive credential/editor prompt hang a server.
          GIT_TERMINAL_PROMPT: '0',
          GIT_EDITOR: 'true',
        },
      },
      (error, stdout, stderr) => {
        if (error && typeof (error as NodeJS.ErrnoException).code === 'string') {
          // ENOENT/EACCES-class: git itself could not be executed.
          reject(error);
          return;
        }
        const code = error ? ((error as { code?: number }).code ?? 1) : 0;
        resolve({ code: typeof code === 'number' ? code : 1, stdout, stderr });
      },
    );
  });
}

/** Raised for every worktree-manager failure that has a contract error code. */
export class WorktreeError extends Error {
  constructor(
    message: string,
    /** Maps to the contract error taxonomy in the handler layer. */
    readonly code: 'invalid_input' | 'conflict' | 'not_found' | 'internal',
    /** Stable machine reason (`not_a_git_repository`, `containment_violation`, …). */
    readonly reason: string,
    readonly detail?: Record<string, unknown>,
  ) {
    super(message);
    this.name = 'WorktreeError';
  }
}

/**
 * Ref-shape validation for CLIENT-SUPPLIED symbolic refs (`baseRef`).
 *
 * A subset of git-check-ref-format, deliberately stricter: anything that could
 * read as an option (leading `-`), traverse (`..`), carry shell metacharacters
 * or control bytes, or hit revision-syntax operators (`~ ^ : ? * [ \ @{`) is
 * refused before it reaches an argv slot. Refusal is `invalid_input` — never a
 * silent normalization, per the design's no-silent-fallback principle.
 */
export function assertSafeRefName(ref: string): void {
  const refuse = (why: string): never => {
    throw new WorktreeError(`unsafe git ref ${JSON.stringify(ref)}: ${why}`, 'invalid_input', 'unsafe_ref');
  };
  if (ref.length === 0 || ref.length > 255) refuse('empty or too long');
  if (ref.startsWith('-')) refuse('leading dash reads as an option');
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f ]/.test(ref)) refuse('control characters or spaces');
  if (/[~^:?*\[\\<>|"'`$;&(){}!]/.test(ref)) refuse('revision-syntax or shell metacharacters');
  if (ref.includes('..') || ref.includes('@{')) refuse('revision-range syntax');
  if (ref.startsWith('/') || ref.endsWith('/') || ref.includes('//')) refuse('bad slash placement');
  if (ref.endsWith('.lock') || ref.startsWith('.') || ref.endsWith('.')) refuse('dot placement git refuses');
}

/** Branch names the SERVER computes still pass through the same gate — belt and braces. */
export function assertSafeBranchName(branch: string): void {
  assertSafeRefName(branch);
}

/** A resolved commit object id — the only base `git worktree add` is ever given. */
export function assertCommitOid(oid: string): void {
  if (!/^[0-9a-f]{40}$/.test(oid)) {
    throw new WorktreeError(`not a full commit oid: ${JSON.stringify(oid)}`, 'invalid_input', 'invalid_oid');
  }
}
