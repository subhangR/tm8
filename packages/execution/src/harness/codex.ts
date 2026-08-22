/**
 * `codex` — Tier B: resume-capable, bespoke prompt delivery.
 *
 * Codex is the proof that Tier B is real, in three details tm8 could only find
 * by RUNNING the thing. Each is preserved verbatim below because the comment is
 * the asset here, not the code: every one records a measured production defect.
 */
import type { PermissionMode } from '../spawn/types.js';
import type { ResolvedLaunchConfig } from '../spawn/manifest.js';
import { codexLoopbackConfigArgs } from '../spawn/manifest.js';
import { quoted, type ArgToken, type BuildArgvOptions, type Harness } from './types.js';

/**
 * tm8's four postures → Codex's `--ask-for-approval` policy.
 *
 * `interactive` maps to `untrusted` and NOT to `on-request`, which is the honest
 * answer for an unattended launch: a policy that stops to ask is a policy that
 * hangs, and `untrusted` at least confines what runs without asking. The pairing
 * with the sandbox below is what makes it usable. Mirrors maestro's
 * `mapApprovalPolicy` (codex-spawner.ts:101).
 */
export function mapCodexApprovalPolicy(mode: PermissionMode): string {
  switch (mode) {
    // Codex has no `auto` of its own, and inventing one out of `on-request`
    // would be a REGRESSION dressed as a translation: `on-request` stops to ask,
    // and there is nobody at this PTY to answer. `auto` is tm8's default, so
    // codex sessions that name no posture must keep landing exactly where they
    // land today — `never` + `workspace-write`, i.e. `acceptEdits`.
    case 'auto':
    case 'acceptEdits':
      return 'never';
    case 'readOnly':
    case 'interactive':
      return 'untrusted';
    case 'bypassPermissions':
      // Unreachable — the caller emits
      // --dangerously-bypass-approvals-and-sandbox instead.
      return 'never';
  }
}

/**
 * Turn OFF Codex's start-up self-update. NOT a preference — without it a codex
 * session on this deployment cannot survive its own boot.
 *
 * WHAT IT DOES WHEN LEFT ON. Codex checks GitHub releases and the npm registry
 * on TUI start, caches the answer in `$CODEX_HOME/version.json`, and — if the
 * running binary is behind — spawns `npm install @openai/codex` AS A DIRECT
 * CHILD and tears its own TUI down. tm8's PTY sees its child exit and records
 * the session `failed`. The agent never reads its brief.
 *
 * MEASURED 2026-08-22 (codex 0.146.0 installed, 0.149.0 on npm): session
 * 01a028e2 died `failed` in 1.686s having rewritten `version.json` with
 * `"latest_version":"0.149.0"`; `ps -eo pid=,ppid=,args=` caught
 * `npm install @openai/codex` with ppid = the codex process. With this override
 * the same spawn was still alive and `idle` at 141s.
 *
 * WHY THIS KEY AND NOT `--disable in_app_updates`. That feature flag looked like
 * the gate and is not: a session spawned with it reporting `false` STILL forked
 * the updater and STILL died (session 01a02948, 6.3s).
 *
 * WHY IT LIVES HERE. This is per-harness flag knowledge, which is exactly what
 * the registry exists to hold — the fix originally landed inside the old
 * `buildCodexArgs`, the function this file replaced. Re-exported from
 * `../spawn/manifest.js` so the public surface is unchanged.
 */
export const CODEX_DISABLE_STARTUP_UPDATE_CHECK = 'check_for_update_on_startup=false';

/** Expand the start-up self-update kill switch into its exact CLI argv. */
export function codexUpdateCheckConfigArgs(): string[] {
  return ['-c', CODEX_DISABLE_STARTUP_UPDATE_CHECK];
}

/** tm8 postures → Codex's `--sandbox` mode. */
export function mapCodexSandboxMode(mode: PermissionMode): string {
  switch (mode) {
    case 'auto':
    case 'acceptEdits':
    case 'interactive':
    case 'readOnly':
      // Codex's legacy read-only sandbox has no supported network-enable key.
      // tm8 plan agents still have to call the loopback graph API, so they run
      // in workspace-write with source edits explicitly prohibited by the
      // trusted launch prompt. See CODEX-COMMAND-NETWORK.md.
      return 'workspace-write';
    case 'bypassPermissions':
      // Unreachable — see mapCodexApprovalPolicy.
      return 'danger-full-access';
  }
}

export const codexHarness: Harness = {
  id: 'codex',
  binary: 'codex',
  exec: 'codex',

  capabilities: {
    credentialProvider: 'openai',
    configDirName: '.codex',

    /**
     * The system prompt travels as `-c developer_instructions=<json>`.
     *
     * THE KEY IS LOAD-BEARING: `instructions` is reserved by Codex and SILENTLY
     * IGNORED. A silently-ignored key is the worst possible failure here — the
     * flag is accepted, the session starts, and the agent has no identity.
     */
    systemPromptDelivery: {
      kind: 'config-kv',
      flag: '-c',
      key: 'developer_instructions',
    },
    taskPromptDelivery: 'positional',

    /**
     * `resume` is a SUBCOMMAND and must come before the flags; the rollout id is
     * POSITIONAL and must come after them. That shape is why `idFlag` is null.
     */
    resume: { subcommand: 'resume', idFlag: null },

    /**
     * Codex mints its own rollout id, so tm8 cannot pre-seed one. The id is
     * captured lazily from the rollout at resume time (native-session.ts) and
     * recorded write-once.
     */
    acceptsPreMintedSessionId: false,

    workspaceTrust: 'codex',

    /**
     * Codex ships an OS-level sandbox tm8 drives through flags, and whether this
     * node can run it MUST be probed rather than inferred.
     *
     * Measured on the prod node 2026-08-02: the flag went out, codex started
     * fine, the session reached "Ready when you are.", accepted a message, and
     * then failed EVERY shell command with `bwrap: loopback: Failed
     * RTM_NEWADDR: Operation not permitted`, while tm8 continued to report the
     * session as `running`. Codex ships its OWN bwrap, so "is bwrap installed?"
     * answers yes while the sandbox cannot work.
     */
    commandNetwork: 'loopback-proxy',

    confinement: { probe: 'codex-bwrap' },

    transcriptDialect: 'codex',
  },

  buildArgv(launch: ResolvedLaunchConfig, opts: BuildArgvOptions): ArgToken[] {
    const args: ArgToken[] = [];
    if (launch.model) args.push('--model', quoted(launch.model));

    // FIRST, and in EVERY posture. The start-up self-update is not gated on the
    // approval or sandbox policy chosen below — the bypass branch skips that
    // `else` entirely — so a bypass session is exactly as dead as a confined one
    // without this. See the constant's own comment for the measurement.
    const updateCheck = codexUpdateCheckConfigArgs();
    args.push(updateCheck[0] as string, quoted(updateCheck[1] as string));

    // Codex's approval prompts are the SAME unattended-hang hazard the Claude
    // branch documents. tm8's project trust gate is the human authorization, so
    // every non-bypass session receives an explicit non-interactive posture.
    //
    // `opts.sandboxUnavailable` collapses the second branch into the first.
    // WHY NOT KEEP `--ask-for-approval` AND DROP ONLY `--sandbox`: approvals with
    // no sandbox is a policy that stops to ask with nobody at the terminal to
    // answer — the exact unattended hang this branch was written to design out —
    // and it would buy no confinement in exchange for it. If the node cannot
    // confine, the honest command line says so in one flag rather than implying a
    // gate that will never open.
    if (launch.permissionMode === 'bypassPermissions' || opts.sandboxUnavailable === true) {
      // Explicit full access is preserved exactly: no proxy or sandbox flags are
      // injected into the opt-in bypass path.
      args.push('--dangerously-bypass-approvals-and-sandbox');
    } else {
      args.push('--ask-for-approval', mapCodexApprovalPolicy(launch.permissionMode));
      args.push('--sandbox', mapCodexSandboxMode(launch.permissionMode));
      // One policy source: `codexLoopbackConfigArgs()` already returns the exact
      // `-c <assignment>` pairs. Re-tag them here — the `-c` is fixed CLI
      // vocabulary, the assignment is content and is quoted at the render seam,
      // which is precisely what `renderCodexCommand` used to do by lookbehind.
      const loopback = codexLoopbackConfigArgs();
      for (let index = 0; index < loopback.length; index += 2) {
        args.push(loopback[index] as string, quoted(loopback[index + 1] as string));
      }
    }

    // This PTY is always server-hosted and rendered into a browser xterm, so
    // Codex must stay inline for reconnectable scrollback.
    args.push('--no-alt-screen');

    if (launch.reasoningEffort) {
      args.push('-c', quoted(`model_reasoning_effort=${JSON.stringify(launch.reasoningEffort)}`));
    }

    // NOT passed: `--cd`. The PTY already spawns with the graph-resolved cwd.
    return args;
  },
};
