/**
 * Models the node deliberately offers for a new session.
 *
 * These are concrete provider/tool identifiers, not marketing aliases. The UI
 * renders `label`; the team-member bootstrap stores `model` + `agentTool`; and
 * the execution layer passes the same model to that tool's CLI builder.
 */
/**
 * Reasoning-effort stops a model accepts, in ascending order.
 *
 * Claude Code takes `--effort low|medium|high|max`; Codex takes
 * `-c model_reasoning_effort=` with `xhigh` in between and, for GPT-6 Astra,
 * `ultra` on top. The composer's model popover renders its effort dial over
 * THIS list and disables the control with a reason for a model whose list is
 * empty — so a stop the tool would reject is never offered at compose time.
 */
export type LaunchModelEffort = 'low' | 'medium' | 'high' | 'xhigh' | 'max' | 'ultra';

export const CLAUDE_CODE_EFFORTS = ['low', 'medium', 'high', 'max'] as const satisfies readonly LaunchModelEffort[];
export const CODEX_EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'] as const satisfies readonly LaunchModelEffort[];
export const CODEX_ULTRA_EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'] as const satisfies readonly LaunchModelEffort[];
/**
 * The three stops OpenAI's open-weight models accept when Codex is pointed at
 * Groq. Deliberately NOT `CODEX_EFFORTS`: `xhigh` and `max` are OpenAI-hosted
 * vocabulary, and offering them here would put a value in
 * `model_reasoning_effort` that the Groq endpoint rejects at the first turn.
 */
export const GROQ_GPT_OSS_EFFORTS = ['low', 'medium', 'high'] as const satisfies readonly LaunchModelEffort[];

export interface LaunchModelCatalogEntry {
  readonly model: string;
  readonly label: string;
  /**
   * The vendor that SERVES the model, which is not always the vendor whose
   * wire protocol carries it. `moonshot` is the case that makes the
   * distinction load-bearing: Kimi speaks Anthropic's protocol, so its
   * `agentTool` is `claude-code` while its provider is Moonshot. Presentation
   * only — nothing switches on it, and the UI's own catalog widens it to a
   * free string so a browser-added model can name a vendor nobody here listed.
   */
  readonly provider: 'anthropic' | 'openai' | 'moonshot' | 'groq';
  readonly agentTool: 'claude-code' | 'codex';
  readonly note: string;
  readonly seedName: string;
  /** Effort stops this model accepts, ascending. Empty = effort not tunable. */
  readonly efforts: readonly LaunchModelEffort[];
}

export const LAUNCH_MODEL_CATALOG = [
  {
    model: 'claude-opus-5',
    label: 'Claude Opus 5',
    provider: 'anthropic',
    agentTool: 'claude-code',
    note: 'Anthropic model via Claude Code',
    seedName: 'Opus 5 Teammate',
    efforts: CLAUDE_CODE_EFFORTS,
  },
  {
    model: 'claude-opus-5[1m]',
    label: 'Claude Opus 5 (1M)',
    provider: 'anthropic',
    agentTool: 'claude-code',
    note: '1M-context variant via Claude Code',
    seedName: 'Opus 5 1M Teammate',
    efforts: CLAUDE_CODE_EFFORTS,
  },
  {
    model: 'claude-fable-5',
    label: 'Claude Fable 5',
    provider: 'anthropic',
    agentTool: 'claude-code',
    note: 'Anthropic model via Claude Code',
    seedName: 'Fable 5 Teammate',
    efforts: CLAUDE_CODE_EFFORTS,
  },
  {
    model: 'claude-fable-5[1m]',
    label: 'Claude Fable 5 (1M)',
    provider: 'anthropic',
    agentTool: 'claude-code',
    note: '1M-context variant via Claude Code',
    seedName: 'Fable 5 1M Teammate',
    efforts: CLAUDE_CODE_EFFORTS,
  },
  {
    model: 'claude-fable-5-1',
    label: 'Claude Fable 5.1',
    provider: 'anthropic',
    agentTool: 'claude-code',
    note: 'Anthropic model via Claude Code — needs Claude Code 2.1.251 or newer',
    seedName: 'Fable 5.1 Teammate',
    efforts: CLAUDE_CODE_EFFORTS,
  },
  {
    model: 'claude-fable-5-1[1m]',
    label: 'Claude Fable 5.1 (1M)',
    provider: 'anthropic',
    agentTool: 'claude-code',
    note: '1M-context variant via Claude Code — needs Claude Code 2.1.251 or newer',
    seedName: 'Fable 5.1 1M Teammate',
    efforts: CLAUDE_CODE_EFFORTS,
  },
  {
    model: 'gpt-6-astra',
    label: 'OpenAI GPT 6 Astra',
    provider: 'openai',
    agentTool: 'codex',
    note: 'GPT-6 Astra via Codex CLI — low, medium, high, xhigh, max and ultra effort',
    seedName: 'GPT 6 Astra Teammate',
    efforts: CODEX_ULTRA_EFFORTS,
  },
  {
    model: 'gpt-5.6-sol',
    label: 'OpenAI GPT 5.6',
    provider: 'openai',
    agentTool: 'codex',
    note: 'Sol coding variant via Codex CLI',
    seedName: 'GPT 5.6 Teammate',
    efforts: CODEX_EFFORTS,
  },
  {
    model: 'gpt-5.6-terra',
    label: 'OpenAI GPT 5.6 Terra',
    provider: 'openai',
    agentTool: 'codex',
    note: 'Balanced coding variant via Codex CLI',
    seedName: 'GPT 5.6 Terra Teammate',
    efforts: CODEX_EFFORTS,
  },
  {
    model: 'gpt-5.6-luna',
    label: 'OpenAI GPT 5.6 Luna',
    provider: 'openai',
    agentTool: 'codex',
    note: 'Lowest-cost coding variant via Codex CLI',
    seedName: 'GPT 5.6 Luna Teammate',
    efforts: CODEX_EFFORTS,
  },
  {
    model: 'claude-sonnet-5',
    label: 'Claude Sonnet 5',
    provider: 'anthropic',
    agentTool: 'claude-code',
    note: 'Anthropic model via Claude Code',
    seedName: 'Sonnet 5 Teammate',
    efforts: CLAUDE_CODE_EFFORTS,
  },
  {
    model: 'claude-haiku-4-5-20251001',
    label: 'Claude Haiku 4.5',
    provider: 'anthropic',
    agentTool: 'claude-code',
    note: 'Version-pinned fast Anthropic model via Claude Code',
    seedName: 'Haiku 4.5 Teammate',
    efforts: CLAUDE_CODE_EFFORTS,
  },

  // ---------------------------------------------------------------------
  // Kimi (Moonshot AI) — the cross-provider rungs.
  //
  // WHY THEY SAY `claude-code`. Moonshot serves an Anthropic-wire-compatible
  // surface at api.moonshot.ai/anthropic, so these run on the SAME binary as
  // the Anthropic rows above: `claude --model kimi-k2-thinking`. The redirect
  // is `API_KEY_BACKEND_ROUTING.kimi` in the execution package, which sets
  // ANTHROPIC_BASE_URL and ANTHROPIC_AUTH_TOKEN for the session.
  //
  // WHAT THAT COSTS, SAID PLAINLY. That redirect is ACCOUNT-WIDE and it
  // DISPLACES anthropic: it is not selected per model. So a Kimi row here is
  // only launchable by a member who has connected the Kimi key on the
  // Connections screen, and while it is connected EVERY claude-code session
  // for that account goes to Moonshot — including the Anthropic rows above,
  // which will then be asked of a server that has never heard of them. The
  // catalog cannot enforce that (credential state is a per-member fact the
  // contract does not see), so each `note` says it instead, and the picker
  // renders the note.
  //
  // EFFORT IS EMPTY, not merely unspecified. Claude Code's `--effort` maps to
  // Anthropic's extended-thinking budget; Moonshot's models decide their own,
  // and `kimi-k2-thinking` reasons whether or not a flag asks it to. An empty
  // list makes the composer draw the dial disabled with "has one fixed effort
  // level" rather than offering four stops the backend would ignore.
  {
    model: 'kimi-k2-thinking',
    label: 'Kimi K2 Thinking',
    provider: 'moonshot',
    agentTool: 'claude-code',
    note: 'Moonshot reasoning model on Claude Code — needs the Kimi key connected, which routes ALL claude-code sessions for the account',
    seedName: 'Kimi K2 Thinking Teammate',
    efforts: [],
  },
  {
    model: 'kimi-k2-thinking-turbo',
    label: 'Kimi K2 Thinking (Turbo)',
    provider: 'moonshot',
    agentTool: 'claude-code',
    note: 'Faster-serving variant of K2 Thinking — needs the Kimi key connected, which routes ALL claude-code sessions for the account',
    seedName: 'Kimi K2 Thinking Turbo Teammate',
    efforts: [],
  },
  {
    model: 'kimi-k2-turbo-preview',
    label: 'Kimi K2 Turbo',
    provider: 'moonshot',
    agentTool: 'claude-code',
    note: 'Non-reasoning K2 at turbo throughput — needs the Kimi key connected, which routes ALL claude-code sessions for the account',
    seedName: 'Kimi K2 Turbo Teammate',
    efforts: [],
  },
  {
    model: 'kimi-k2-0905-preview',
    label: 'Kimi K2 (0905)',
    provider: 'moonshot',
    agentTool: 'claude-code',
    note: 'Date-pinned K2 — needs the Kimi key connected, which routes ALL claude-code sessions for the account',
    seedName: 'Kimi K2 0905 Teammate',
    efforts: [],
  },

  // ---------------------------------------------------------------------
  // Groq — the same cross-provider arrangement on the Codex side.
  //
  // `API_KEY_BACKEND_ROUTING.groq` points OPENAI_BASE_URL at
  // api.groq.com/openai/v1 and displaces `openai`, so these rows run on the
  // Codex binary: `codex --model openai/gpt-oss-120b`. Every caveat written
  // over the Kimi block applies unchanged and in the other direction — the
  // key is account-wide, and while it is connected the GPT rows above are
  // being asked of a server that does not serve them.
  //
  // THE MODEL IDS CARRY THEIR VENDOR PREFIX (`openai/`, `moonshotai/`,
  // `qwen/`) because that is literally what Groq's API expects; they are not
  // decoration and must not be tidied away.
  {
    model: 'openai/gpt-oss-120b',
    label: 'GPT-OSS 120B (Groq)',
    provider: 'groq',
    agentTool: 'codex',
    note: 'OpenAI open-weight 120B on Groq — needs the Groq key connected, which routes ALL codex sessions for the account',
    seedName: 'GPT-OSS 120B Teammate',
    efforts: GROQ_GPT_OSS_EFFORTS,
  },
  {
    model: 'openai/gpt-oss-20b',
    label: 'GPT-OSS 20B (Groq)',
    provider: 'groq',
    agentTool: 'codex',
    note: 'Smallest open-weight rung, for cheap mechanical work — needs the Groq key connected, which routes ALL codex sessions for the account',
    seedName: 'GPT-OSS 20B Teammate',
    efforts: GROQ_GPT_OSS_EFFORTS,
  },
  {
    model: 'moonshotai/kimi-k2-instruct-0905',
    label: 'Kimi K2 Instruct (Groq)',
    provider: 'groq',
    agentTool: 'codex',
    note: 'Kimi K2 served by Groq on the Codex side — a DIFFERENT route to Moonshot than the Kimi rows above, which use Claude Code',
    seedName: 'Kimi K2 Instruct Groq Teammate',
    efforts: [],
  },
  {
    model: 'llama-3.3-70b-versatile',
    label: 'Llama 3.3 70B (Groq)',
    provider: 'groq',
    agentTool: 'codex',
    note: 'Meta Llama 3.3 70B on Groq — needs the Groq key connected, which routes ALL codex sessions for the account',
    seedName: 'Llama 3.3 70B Teammate',
    efforts: [],
  },
  {
    model: 'qwen/qwen3-32b',
    label: 'Qwen3 32B (Groq)',
    provider: 'groq',
    agentTool: 'codex',
    note: 'Qwen3 32B on Groq — needs the Groq key connected, which routes ALL codex sessions for the account',
    seedName: 'Qwen3 32B Teammate',
    efforts: [],
  },
  {
    model: 'deepseek-r1-distill-llama-70b',
    label: 'DeepSeek R1 Distill 70B (Groq)',
    provider: 'groq',
    agentTool: 'codex',
    note: 'Reasoning distill on Groq — needs the Groq key connected, which routes ALL codex sessions for the account',
    seedName: 'DeepSeek R1 Distill 70B Teammate',
    efforts: [],
  },
] as const satisfies readonly LaunchModelCatalogEntry[];

/** Effort stops for a catalog model; `[]` for a model the catalog does not know. */
export function launchModelEfforts(model: string | null | undefined): readonly LaunchModelEffort[] {
  return launchModel(model)?.efforts ?? [];
}

export function launchModel(model: string | null | undefined): LaunchModelCatalogEntry | undefined {
  return LAUNCH_MODEL_CATALOG.find((entry) => entry.model === model);
}
