/**
 * Models the node deliberately offers for a new session.
 *
 * These are concrete provider/tool identifiers, not marketing aliases. The UI
 * renders `label`, and the execution layer passes the same model to that tool's
 * CLI builder. A model is a choice made on a teammate or per launch; it no
 * longer mints a teammate of its own (see `HOUSE_TEAMMATE_NAMES`).
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
 * The three stops Groq's open-weight reasoning models accept — the GPT-OSS
 * pair and Qwen 3.8. Deliberately NOT `CODEX_EFFORTS`: `max` is OpenAI-hosted
 * vocabulary, and offering it here would put a value in
 * `model_reasoning_effort` that the Groq endpoint rejects at the first turn.
 * `xhigh` is excluded for a narrower reason — on Groq it belongs to Muse Spark
 * alone (see `GROQ_MUSE_SPARK_EFFORTS`), not to open-weight models generally.
 *
 * Groq additionally documents `none` and `default` for Qwen 3.8. Neither is a
 * `LaunchModelEffort`, and neither needs to be: "no reasoning" is not a stop on
 * a dial the composer can render, and `default` is what sending nothing means.
 */
export const GROQ_OPEN_WEIGHT_EFFORTS = ['low', 'medium', 'high'] as const satisfies readonly LaunchModelEffort[];

/**
 * Muse Spark Open is the one model on Groq that takes `xhigh`, and it is that
 * model's DEFAULT rather than its ceiling. `none` is absent because Groq states
 * the model always reasons, so there is no off position to offer.
 */
export const GROQ_MUSE_SPARK_EFFORTS = ['low', 'medium', 'high', 'xhigh'] as const satisfies readonly LaunchModelEffort[];

export interface LaunchModelCatalogEntry {
  readonly model: string;
  readonly label: string;
  /**
   * The vendor that SERVES the model, which is not always the vendor whose
   * wire protocol carries it. `moonshot` is the case that makes the
   * distinction load-bearing: Kimi speaks Anthropic's protocol, so its
   * `agentTool` is `claude-code` while its provider is Moonshot. Spawn routes
   * on it: `apiKeyBackendForModel` in `@tm8/execution` sends a `moonshot` row
   * to the member's Kimi key and a `groq` row to their Groq key, and every
   * other row to the tool's native login. The UI's own catalog widens it to a
   * free string so a browser-added model can name a vendor nobody here listed;
   * such a model is not in this catalog and runs on the native login.
   */
  readonly provider: 'anthropic' | 'openai' | 'moonshot' | 'groq';
  readonly agentTool: 'claude-code' | 'codex';
  readonly note: string;
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
    efforts: CLAUDE_CODE_EFFORTS,
  },
  {
    model: 'claude-opus-5[1m]',
    label: 'Claude Opus 5 (1M)',
    provider: 'anthropic',
    agentTool: 'claude-code',
    note: '1M-context variant via Claude Code',
    efforts: CLAUDE_CODE_EFFORTS,
  },
  {
    model: 'claude-opus-5-5',
    label: 'Claude Opus 5.5',
    provider: 'anthropic',
    agentTool: 'claude-code',
    note: 'Anthropic model via Claude Code',
    efforts: CLAUDE_CODE_EFFORTS,
  },
  {
    model: 'claude-opus-5-5[1m]',
    label: 'Claude Opus 5.5 (1M)',
    provider: 'anthropic',
    agentTool: 'claude-code',
    note: '1M-context variant via Claude Code',
    efforts: CLAUDE_CODE_EFFORTS,
  },
  {
    model: 'claude-fable-5',
    label: 'Claude Fable 5',
    provider: 'anthropic',
    agentTool: 'claude-code',
    note: 'Anthropic model via Claude Code',
    efforts: CLAUDE_CODE_EFFORTS,
  },
  {
    model: 'claude-fable-5[1m]',
    label: 'Claude Fable 5 (1M)',
    provider: 'anthropic',
    agentTool: 'claude-code',
    note: '1M-context variant via Claude Code',
    efforts: CLAUDE_CODE_EFFORTS,
  },
  {
    model: 'claude-fable-5-1',
    label: 'Claude Fable 5.1',
    provider: 'anthropic',
    agentTool: 'claude-code',
    note: 'Anthropic model via Claude Code — needs Claude Code 2.1.251 or newer',
    efforts: CLAUDE_CODE_EFFORTS,
  },
  {
    model: 'claude-fable-5-1[1m]',
    label: 'Claude Fable 5.1 (1M)',
    provider: 'anthropic',
    agentTool: 'claude-code',
    note: '1M-context variant via Claude Code — needs Claude Code 2.1.251 or newer',
    efforts: CLAUDE_CODE_EFFORTS,
  },
  {
    model: 'gpt-6-astra',
    label: 'OpenAI GPT 6 Astra',
    provider: 'openai',
    agentTool: 'codex',
    note: 'GPT-6 Astra via Codex CLI — low, medium, high, xhigh, max and ultra effort',
    efforts: CODEX_ULTRA_EFFORTS,
  },
  {
    model: 'gpt-6.1-sol',
    label: 'OpenAI GPT 6.1 Sol',
    provider: 'openai',
    agentTool: 'codex',
    note: 'Near-Astra coding model via Codex CLI',
    efforts: CODEX_EFFORTS,
  },
  {
    model: 'gpt-5.6-sol',
    label: 'OpenAI GPT 5.6',
    provider: 'openai',
    agentTool: 'codex',
    note: 'Sol coding variant via Codex CLI',
    efforts: CODEX_EFFORTS,
  },
  {
    model: 'gpt-5.6-terra',
    label: 'OpenAI GPT 5.6 Terra',
    provider: 'openai',
    agentTool: 'codex',
    note: 'Balanced coding variant via Codex CLI',
    efforts: CODEX_EFFORTS,
  },
  {
    model: 'gpt-5.6-luna',
    label: 'OpenAI GPT 5.6 Luna',
    provider: 'openai',
    agentTool: 'codex',
    note: 'Lowest-cost coding variant via Codex CLI',
    efforts: CODEX_EFFORTS,
  },
  {
    model: 'claude-sonnet-5',
    label: 'Claude Sonnet 5',
    provider: 'anthropic',
    agentTool: 'claude-code',
    note: 'Anthropic model via Claude Code',
    efforts: CLAUDE_CODE_EFFORTS,
  },
  {
    model: 'claude-sonnet-5-5',
    label: 'Claude Sonnet 5.5',
    provider: 'anthropic',
    agentTool: 'claude-code',
    note: '1M-context Anthropic model via Claude Code',
    efforts: CLAUDE_CODE_EFFORTS,
  },
  {
    model: 'claude-haiku-4-5-20251001',
    label: 'Claude Haiku 4.5',
    provider: 'anthropic',
    agentTool: 'claude-code',
    note: 'Version-pinned fast Anthropic model via Claude Code',
    efforts: CLAUDE_CODE_EFFORTS,
  },
  {
    model: 'claude-haiku-5-5',
    label: 'Claude Haiku 5.5',
    provider: 'anthropic',
    agentTool: 'claude-code',
    note: 'Fast 1M-context Anthropic model via Claude Code',
    efforts: CLAUDE_CODE_EFFORTS,
  },

  // ---------------------------------------------------------------------
  // Kimi (Moonshot AI) — the cross-provider rungs.
  //
  // WHY THEY SAY `claude-code`. Moonshot serves an Anthropic-wire-compatible
  // surface at api.moonshot.ai/anthropic, so these run on the SAME binary as
  // the Anthropic rows above: `claude --model kimi-k3`. The redirect
  // is `API_KEY_BACKEND_ROUTING.kimi` in the execution package, which sets
  // ANTHROPIC_BASE_URL and ANTHROPIC_AUTH_TOKEN for the session.
  //
  // THE REDIRECT IS PER MODEL. `apiKeyBackendForModel` applies it only to the
  // rows below (`provider: 'moonshot'`), so a Kimi row runs on the member's
  // Kimi key and the Anthropic rows above keep running on their Anthropic
  // login whether or not a Kimi key is connected. A Kimi row launched by a
  // member with no Kimi key is refused at spawn, naming the key. The catalog
  // cannot see credential state (a per-member fact), so each `note` says which
  // key the row needs, and the picker renders the note.
  //
  // EFFORT IS EMPTY, not merely unspecified. Claude Code's `--effort` maps to
  // Anthropic's extended-thinking budget; Moonshot's models decide their own,
  // and Moonshot documents no reasoning-effort parameter for any of them. An
  // empty list makes the composer draw the dial disabled with "has one fixed
  // effort level" rather than offering four stops the backend would ignore.
  //
  // THESE IDS ROT. The K2 generation these rows used to name (`kimi-k2-thinking`
  // and friends) was discontinued on 2026-05-25 and every one of those launches
  // failed at the provider, unnoticed here because the rows only run on a
  // member's own key. Check them against platform.kimi.ai/docs/models rather
  // than assuming a once-correct id is still served.
  {
    model: 'kimi-k3',
    label: 'Kimi K3',
    provider: 'moonshot',
    agentTool: 'claude-code',
    note: "Moonshot's flagship, 1M context and native vision — runs on your own Kimi key (Settings → Connections)",
    efforts: [],
  },
  {
    model: 'kimi-k2.6',
    label: 'Kimi K2.6',
    provider: 'moonshot',
    agentTool: 'claude-code',
    note: 'General model with thinking and non-thinking modes, 256k — runs on your own Kimi key (Settings → Connections)',
    efforts: [],
  },
  {
    model: 'kimi-k2.7-code',
    label: 'Kimi K2.7 Code',
    provider: 'moonshot',
    agentTool: 'claude-code',
    note: 'Coding model for long-context instruction following, 256k — runs on your own Kimi key (Settings → Connections)',
    efforts: [],
  },
  {
    model: 'kimi-k2.7-code-highspeed',
    label: 'Kimi K2.7 Code (High-speed)',
    provider: 'moonshot',
    agentTool: 'claude-code',
    note: 'Faster-serving K2.7 Code, ~180 tok/s — runs on your own Kimi key (Settings → Connections)',
    efforts: [],
  },

  // ---------------------------------------------------------------------
  // Groq — the same cross-provider arrangement on the Codex side.
  //
  // `API_KEY_BACKEND_ROUTING.groq` points OPENAI_BASE_URL at
  // api.groq.com/openai/v1 for these rows only, so they run on the
  // Codex binary: `codex --model openai/gpt-oss-120b`. The same per-model
  // rule applies: only these rows use the Groq key, and the GPT rows above
  // keep running on the member's OpenAI login.
  //
  // THE MODEL IDS CARRY THEIR VENDOR PREFIX (`openai/`, `qwen/`,
  // `minimaxai/`, `meta-models/`) because that is literally what Groq's API
  // expects; they are not decoration and must not be tidied away. Note that
  // `llama-3.3-70b-versatile` genuinely has no prefix — that is Groq's own
  // spelling, not an omission.
  //
  // THESE IDS ROT, AND GROQ PUBLISHES THE DATES. Three rows here previously
  // named models Groq had already shut down: `moonshotai/kimi-k2-instruct-0905`
  // (2026-04-15), `qwen/qwen3-32b` (2026-07-17) and
  // `deepseek-r1-distill-llama-70b` (2025-10-02). Groq no longer serves ANY
  // Moonshot or DeepSeek model, so those two rows could not be renamed in
  // place; they were replaced with current Groq models rather than pointed at
  // `openai/gpt-oss-120b`, which this catalog already offers. Check
  // console.groq.com/docs/deprecations before trusting a row here.
  {
    model: 'openai/gpt-oss-120b',
    label: 'GPT-OSS 120B (Groq)',
    provider: 'groq',
    agentTool: 'codex',
    note: 'OpenAI open-weight 120B on Groq — runs on your own Groq key (Settings → Connections)',
    efforts: GROQ_OPEN_WEIGHT_EFFORTS,
  },
  {
    model: 'openai/gpt-oss-20b',
    label: 'GPT-OSS 20B (Groq)',
    provider: 'groq',
    agentTool: 'codex',
    note: 'Smallest open-weight rung, for cheap mechanical work — runs on your own Groq key (Settings → Connections)',
    efforts: GROQ_OPEN_WEIGHT_EFFORTS,
  },
  {
    model: 'meta-models/muse-spark-open',
    label: 'Muse Spark Open (Groq)',
    provider: 'groq',
    agentTool: 'codex',
    note: 'The only model on Groq that takes xhigh effort, and its default — runs on your own Groq key (Settings → Connections)',
    efforts: GROQ_MUSE_SPARK_EFFORTS,
  },
  {
    model: 'llama-3.3-70b-versatile',
    label: 'Llama 3.3 70B (Groq)',
    provider: 'groq',
    agentTool: 'codex',
    note: 'Meta Llama 3.3 70B on Groq — runs on your own Groq key (Settings → Connections)',
    efforts: [],
  },
  {
    model: 'qwen/qwen3.8-27b',
    label: 'Qwen3.8 27B (Groq)',
    provider: 'groq',
    agentTool: 'codex',
    note: 'Qwen3.8 27B on Groq, the successor to Qwen3 32B — runs on your own Groq key (Settings → Connections)',
    efforts: GROQ_OPEN_WEIGHT_EFFORTS,
  },
  {
    model: 'minimaxai/minimax-m2.7',
    label: 'MiniMax M2.7 (Groq)',
    provider: 'groq',
    agentTool: 'codex',
    note: 'Largest context on Groq at 196k — runs on your own Groq key (Settings → Connections)',
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
