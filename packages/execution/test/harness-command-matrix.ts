/**
 * The command-rendering matrix that Phase 0's golden is computed over.
 *
 * Shared by the golden test and the generator that produced the committed
 * fixture, so the two can never drift into measuring different things.
 *
 * WHY A MATRIX AND NOT HAND-PICKED CASES. The harness-registry refactor claims
 * the rendered command string is byte-identical for every real harness. A claim
 * of that shape is only worth the coverage behind it, and the design's own
 * self-critique named this as the gap: "nothing proves they cover every branch
 * of buildAgentCommand x five PermissionMode values x the sandboxUnavailable
 * and claudeSessionId options." This enumerates that product exhaustively
 * rather than sampling it.
 */
import type { ResolvedLaunchConfig } from '../src/spawn/manifest.js';

export const PERMISSION_MODES = [
  'auto',
  'acceptEdits',
  'interactive',
  'readOnly',
  'bypassPermissions',
] as const;

export const AGENT_TOOLS = ['claude-code', 'codex', 'echo-agent'] as const;

/** Models and efforts are varied because both are shell-quoted values. */
const MODELS = [null, 'claude-opus-5', "weird 'model' name"] as const;
const EFFORTS = [null, 'high'] as const;
const SESSION_IDS = [null, '3f2504e0-4f89-11d3-9a0c-0305e82c3301'] as const;
const SANDBOX = [false, true] as const;

/** A launch config with every field the command builders read. */
export function launchFor(
  agentTool: string,
  permissionMode: (typeof PERMISSION_MODES)[number],
  model: string | null,
  reasoningEffort: string | null,
): ResolvedLaunchConfig {
  return {
    mode: 'worker',
    model,
    agentTool,
    permissionMode,
    accessMode: 'safe',
    reasoningEffort: reasoningEffort as ResolvedLaunchConfig['reasoningEffort'],
    credentialSource: null,
    credentialSources: {},
  } as ResolvedLaunchConfig;
}

export interface MatrixCase {
  readonly key: string;
  readonly launch: ResolvedLaunchConfig;
  readonly opts: { claudeSessionId?: string | null; sandboxUnavailable?: boolean };
  readonly env: NodeJS.ProcessEnv;
}

/**
 * Every combination the three real harnesses can be rendered under, plus the
 * two TM8_AGENT_CMD operator-override shapes: a bare provider name (which still
 * routes through that provider's argument builder) and a full wrapper path
 * (which is used verbatim). Both are behaviour the registry must preserve.
 */
export function commandMatrix(): MatrixCase[] {
  const cases: MatrixCase[] = [];
  for (const agentTool of AGENT_TOOLS) {
    for (const permissionMode of PERMISSION_MODES) {
      for (const model of MODELS) {
        for (const reasoningEffort of EFFORTS) {
          for (const claudeSessionId of SESSION_IDS) {
            for (const sandboxUnavailable of SANDBOX) {
              cases.push({
                key: [
                  agentTool,
                  permissionMode,
                  `model=${model ?? '-'}`,
                  `effort=${reasoningEffort ?? '-'}`,
                  `sid=${claudeSessionId ? 'set' : '-'}`,
                  `sandboxUnavailable=${sandboxUnavailable}`,
                ].join(' | '),
                launch: launchFor(agentTool, permissionMode, model, reasoningEffort),
                opts: { claudeSessionId, sandboxUnavailable },
                env: {},
              });
            }
          }
        }
      }
    }
  }

  // TM8_AGENT_CMD is a node-wide operator override and wins over every
  // resolved agentTool. A bare provider name still reaches that provider's
  // builder; anything else is a complete operator-owned command used verbatim.
  for (const override of ['codex', 'claude', '/opt/wrap/agent --flag']) {
    for (const permissionMode of PERMISSION_MODES) {
      cases.push({
        key: `override=${override} | ${permissionMode}`,
        launch: launchFor('claude-code', permissionMode, 'claude-opus-5', 'high'),
        opts: { claudeSessionId: '3f2504e0-4f89-11d3-9a0c-0305e82c3301', sandboxUnavailable: false },
        env: { TM8_AGENT_CMD: override },
      });
    }
  }
  return cases;
}

/** The prompt pair appended by `withAgentPrompt`, including quoting hazards. */
export const PROMPT_CASES = [
  { key: 'both', system: 'you are a tm8 worker', task: "do the thing with 'quotes'" },
  { key: 'system-only', system: 'you are a tm8 worker', task: '' },
  { key: 'task-only', system: '', task: 'do the thing' },
  { key: 'neither', system: '', task: '' },
] as const;

export const RESUME_NATIVE_ID = '9b1deb4d-3b7d-4bad-9bdd-2b0d7b3dcb6d';
export const RESUME_SYSTEM = ['re-append me', ''] as const;
