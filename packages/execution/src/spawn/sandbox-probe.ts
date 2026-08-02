// @tm8/execution — is the provider's OS-level sandbox ACTUALLY usable on this
// node, or does tm8 only think it is?
//
// WHY THIS EXISTS. `buildAgentCommand` maps a teammate's `permissionMode` onto
// provider flags, and for every codex posture except `bypassPermissions` it
// emits `--ask-for-approval` + `--sandbox <mode>`. Emitting the flag was treated
// as equivalent to having a sandbox. It is not. Measured on the prod node
// 2026-08-02: the flag went out, codex started fine, the session reached "Ready
// when you are.", accepted a message, and then failed EVERY shell command with
//
//     bwrap: loopback: Failed RTM_NEWADDR: Operation not permitted
//
// while tm8 continued to report the session as `running` and listed it as live.
// A session that cannot run a single command is not a degraded session, it is a
// dead one, and tm8 had no way to say so.
//
// WHY IT IS NOT A BWRAP-ON-PATH CHECK. The obvious probe — "is bwrap
// installed?" — gets the WRONG answer here. codex 0.146.0 ships its own bwrap
// and says so in its banner ("Codex could not find bubblewrap on PATH ... Codex
// will use the bundled bubblewrap in the meantime"), so the sandbox is present
// and still cannot work. The actual blocker on this node is AppArmor:
// `/proc/sys/kernel/apparmor_restrict_unprivileged_userns` is 1 and
// `/etc/apparmor.d/unprivileged_userns` contains `audit deny capability`, so any
// unconfined binary that creates an unprivileged user namespace is transitioned
// into that profile and stripped of every capability. Measured consequence,
// both codex sandbox shapes failing for different reasons at different depths:
//
//     bwrap --unshare-all --share-net   -> setting up uid map: Permission denied
//     bwrap --unshare-all               -> loopback: Failed RTM_NEWADDR
//
// No amount of inspecting paths, capability masks or `systemd-detect-virt`
// predicts that pair. Only running it does.
//
// SO THE PROBE RUNS THE REAL THING. `codex sandbox -- <cmd>` is codex's own
// entry point for "execute this inside the sandbox you would give an agent", so
// it exercises the identical machinery with the identical bundled helper. It is
// the provider's answer to the provider's question, which is the only kind that
// stays true across codex releases.
//
// The result is cached for the life of the process: sandbox viability is a
// property of the node's kernel and LSM policy, and re-probing it per spawn
// would put a subprocess on the hot path of every launch to re-learn a constant.

import { execFile } from 'node:child_process';
import type { Logger } from '../pty/types.js';

/** What the node can actually offer, and — when it cannot — why, in words an
 *  operator can act on rather than a boolean they have to go investigate. */
export type SandboxAvailability =
  | { usable: true }
  | {
      usable: false;
      /** Short machine-ish tag for logs and manifests. */
      reason: 'probe_failed' | 'probe_errored' | 'probe_timed_out' | 'binary_missing';
      /** One sentence naming the precondition that was not met. */
      detail: string;
    };

/** Marker the probe asks the sandboxed command to print. Its ABSENCE from
 *  stdout is the signal, because codex does not reliably fail loudly: a
 *  sandbox that cannot start still exits 0 in some codex paths, so trusting the
 *  exit code alone reports a broken sandbox as a working one. */
const PROBE_MARKER = 'TM8_SANDBOX_PROBE_OK';

const PROBE_TIMEOUT_MS = 15_000;

/** Process-lifetime memo, keyed by the binary actually probed. */
const cache = new Map<string, Promise<SandboxAvailability>>();

/** Drop the memo. Tests only — a node's LSM policy does not change under it. */
export function resetSandboxProbeCache(): void {
  cache.clear();
}

function runProbe(
  binary: string,
  env: NodeJS.ProcessEnv,
): Promise<{ code: number | null; stdout: string; stderr: string; error?: Error }> {
  return new Promise((resolve) => {
    execFile(
      binary,
      ['sandbox', '--', '/bin/echo', PROBE_MARKER],
      { timeout: PROBE_TIMEOUT_MS, env, encoding: 'utf8' },
      (error, stdout, stderr) => {
        const code =
          error && typeof (error as NodeJS.ErrnoException & { code?: number }).code === 'number'
            ? ((error as unknown as { code: number }).code)
            : error
              ? null
              : 0;
        resolve({ code, stdout: stdout ?? '', stderr: stderr ?? '', error: error ?? undefined });
      },
    );
  });
}

/**
 * Can codex confine a command on this node right now?
 *
 * Answers on OBSERVED BEHAVIOUR, never on inference from paths or capability
 * bits — see the module header for why every static signal available here gives
 * the wrong answer on the node this was written against.
 */
export async function probeCodexSandbox(
  options: { binary?: string; env?: NodeJS.ProcessEnv; logger?: Logger } = {},
): Promise<SandboxAvailability> {
  const binary = options.binary ?? 'codex';
  const cached = cache.get(binary);
  if (cached) return cached;

  const env = options.env ?? process.env;
  const promise = (async (): Promise<SandboxAvailability> => {
    let result: Awaited<ReturnType<typeof runProbe>>;
    try {
      result = await runProbe(binary, env);
    } catch (err) {
      // Reaching here means execFile itself threw rather than reporting through
      // its callback. Unknown state is NOT treated as a working sandbox.
      return {
        usable: false,
        reason: 'probe_errored',
        detail: `could not run '${binary} sandbox' to test whether this node can sandbox codex: ${
          err instanceof Error ? err.message : String(err)
        }`,
      };
    }

    const { code, stdout, stderr, error } = result;
    const combined = `${stdout}\n${stderr}`.trim();

    // The marker is the verdict. A sandbox that started, ran the command and
    // let its output through is a working sandbox; anything else is not,
    // whatever the exit code claims.
    if (stdout.includes(PROBE_MARKER)) return { usable: true };

    const errno = (error as NodeJS.ErrnoException | undefined)?.code;
    if (errno === 'ENOENT') {
      return {
        usable: false,
        reason: 'binary_missing',
        detail: `agent CLI '${binary}' is not installed, so its sandbox cannot be tested or used`,
      };
    }
    if ((error as (Error & { killed?: boolean }) | undefined)?.killed) {
      return {
        usable: false,
        reason: 'probe_timed_out',
        detail: `'${binary} sandbox' did not answer within ${PROBE_TIMEOUT_MS}ms; treating the sandbox as unavailable rather than assuming it works`,
      };
    }

    return {
      usable: false,
      reason: 'probe_failed',
      detail:
        `'${binary} sandbox' could not run a trivial command on this node` +
        (code === null ? '' : ` (exit ${String(code)})`) +
        (combined === '' ? '' : `: ${combined.split('\n')[0]}`),
    };
  })();

  cache.set(binary, promise);
  const answer = await promise;
  if (!answer.usable) {
    options.logger?.warn?.('sandbox probe: codex cannot confine commands on this node', {
      binary,
      reason: answer.reason,
      detail: answer.detail,
    });
  }
  return answer;
}
