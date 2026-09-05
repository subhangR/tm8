/**
 * Models the node deliberately offers for a new session.
 *
 * These are concrete provider/tool identifiers, not marketing aliases. The UI
 * renders `label`; the team-member bootstrap stores `model` + `agentTool`; and
 * the execution layer passes the same model to that tool's CLI builder.
 */
export interface LaunchModelCatalogEntry {
  readonly model: string;
  readonly label: string;
  readonly provider: 'anthropic' | 'openai';
  readonly agentTool: 'claude-code' | 'codex';
  readonly note: string;
  readonly seedName: string;
}

export const LAUNCH_MODEL_CATALOG = [
  {
    model: 'claude-opus-5',
    label: 'Claude Opus 5',
    provider: 'anthropic',
    agentTool: 'claude-code',
    note: 'Anthropic model via Claude Code',
    seedName: 'Opus 5 Teammate',
  },
  {
    model: 'claude-opus-5[1m]',
    label: 'Claude Opus 5 (1M)',
    provider: 'anthropic',
    agentTool: 'claude-code',
    note: '1M-context variant via Claude Code',
    seedName: 'Opus 5 1M Teammate',
  },
  {
    model: 'claude-fable-5',
    label: 'Claude Fable 5',
    provider: 'anthropic',
    agentTool: 'claude-code',
    note: 'Anthropic model via Claude Code',
    seedName: 'Fable 5 Teammate',
  },
  {
    model: 'claude-fable-5[1m]',
    label: 'Claude Fable 5 (1M)',
    provider: 'anthropic',
    agentTool: 'claude-code',
    note: '1M-context variant via Claude Code',
    seedName: 'Fable 5 1M Teammate',
  },
  {
    model: 'claude-fable-5-1',
    label: 'Claude Fable 5.1',
    provider: 'anthropic',
    agentTool: 'claude-code',
    note: 'Anthropic model via Claude Code — needs Claude Code 2.1.251 or newer',
    seedName: 'Fable 5.1 Teammate',
  },
  {
    model: 'claude-fable-5-1[1m]',
    label: 'Claude Fable 5.1 (1M)',
    provider: 'anthropic',
    agentTool: 'claude-code',
    note: '1M-context variant via Claude Code — needs Claude Code 2.1.251 or newer',
    seedName: 'Fable 5.1 1M Teammate',
  },
  {
    model: 'gpt-6-astra',
    label: 'OpenAI GPT 6 Astra',
    provider: 'openai',
    agentTool: 'codex',
    note: 'GPT-6 Astra via Codex CLI — low, medium, high, xhigh, max and ultra effort',
    seedName: 'GPT 6 Astra Teammate',
  },
  {
    model: 'gpt-5.6-sol',
    label: 'OpenAI GPT 5.6',
    provider: 'openai',
    agentTool: 'codex',
    note: 'Sol coding variant via Codex CLI',
    seedName: 'GPT 5.6 Teammate',
  },
  {
    model: 'gpt-5.6-terra',
    label: 'OpenAI GPT 5.6 Terra',
    provider: 'openai',
    agentTool: 'codex',
    note: 'Balanced coding variant via Codex CLI',
    seedName: 'GPT 5.6 Terra Teammate',
  },
  {
    model: 'gpt-5.6-luna',
    label: 'OpenAI GPT 5.6 Luna',
    provider: 'openai',
    agentTool: 'codex',
    note: 'Lowest-cost coding variant via Codex CLI',
    seedName: 'GPT 5.6 Luna Teammate',
  },
  {
    model: 'claude-sonnet-5',
    label: 'Claude Sonnet 5',
    provider: 'anthropic',
    agentTool: 'claude-code',
    note: 'Anthropic model via Claude Code',
    seedName: 'Sonnet 5 Teammate',
  },
  {
    model: 'claude-haiku-4-5-20251001',
    label: 'Claude Haiku 4.5',
    provider: 'anthropic',
    agentTool: 'claude-code',
    note: 'Version-pinned fast Anthropic model via Claude Code',
    seedName: 'Haiku 4.5 Teammate',
  },
] as const satisfies readonly LaunchModelCatalogEntry[];

export function launchModel(model: string | null | undefined): LaunchModelCatalogEntry | undefined {
  return LAUNCH_MODEL_CATALOG.find((entry) => entry.model === model);
}
