/**
 * `claude-code` — real Claude Code, the Tier-A reference harness.
 *
 * Flags derive from the manifest the same way old maestro's
 * `ClaudeSpawner.buildBaseArgs` did.
 */
import type { PermissionMode } from '@tm8/contract';
import type { ResolvedLaunchConfig } from '../spawn/manifest.js';
import { quoted, type ArgToken, type BuildArgvOptions, type Harness } from './types.js';

/**
 * tm8's five postures → the `--permission-mode` values Claude accepts.
 *
 * `auto` is passed straight through: it is a first-class Claude Code mode
 * (`--permission-mode` choices are acceptEdits / auto / bypassPermissions /
 * manual / dontAsk / plan, verified against the installed CLI 2026-08-01), and
 * it is the posture a tm8 session gets when nothing named one.
 */
export function mapClaudePermissionMode(mode: PermissionMode): string {
  switch (mode) {
    case 'auto':
      return 'auto';
    case 'acceptEdits':
      return 'acceptEdits';
    case 'readOnly':
      return 'plan';
    case 'interactive':
      return 'default';
    case 'bypassPermissions':
      // Unreachable — the caller emits --dangerously-skip-permissions instead.
      return 'acceptEdits';
  }
}

export const claudeCodeHarness: Harness = {
  id: 'claude-code',
  binary: 'claude',

  capabilities: {
    credentialProvider: 'anthropic',
    configDirName: '.claude',

    /** `--append-system-prompt <text>`; the value is content and is quoted. */
    systemPromptDelivery: { kind: 'flag', flag: '--append-system-prompt' },
    taskPromptDelivery: 'positional',

    /** Resume is a FLAG carrying the pre-minted id, with no subcommand. */
    resume: { subcommand: null, idFlag: '--resume' },

    /**
     * Claude adopts tm8's uuid as its own conversation id when given
     * `--session-id <uuid>` (maestro's claude-spawner pattern), which is what
     * makes `--resume <uuid>` possible later without ever parsing a transcript:
     * the id is known before the agent exists.
     */
    acceptsPreMintedSessionId: true,

    workspaceTrust: 'claude',

    /**
     * Claude Code's permission modes are enforced INSIDE the agent, so there is
     * no OS-level sandbox tm8 drives through flags — nothing here to probe, and
     * nothing that can silently fail the way codex's bwrap did.
     */
    confinement: 'enforced-in-agent',

    transcriptDialect: 'claude-code',
  },

  buildArgv(launch: ResolvedLaunchConfig, opts: BuildArgvOptions): ArgToken[] {
    const args: ArgToken[] = [];
    if (launch.permissionMode === 'bypassPermissions') {
      args.push('--dangerously-skip-permissions');
    } else {
      args.push('--permission-mode', mapClaudePermissionMode(launch.permissionMode));
    }
    if (launch.model) args.push('--model', quoted(launch.model));
    if (launch.reasoningEffort) args.push('--effort', launch.reasoningEffort);
    if (opts.claudeSessionId) args.push('--session-id', quoted(opts.claudeSessionId));
    return args;
  },
};
