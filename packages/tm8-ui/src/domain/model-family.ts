/**
 * WHICH MODEL IS THIS, AT A GLANCE — the family behind a model id.
 *
 * THE DEFECT THIS FIXES, in the user's words: "i'm not able to get and
 * understand the icons of which models are spawning if its kimi grok or claude
 * or gpt, i need to know clear icons distinguishable". They were right and the
 * cause was structural, not cosmetic: a session row printed its model as MONO
 * TEXT and nothing else, so telling `kimi-k2-thinking` from
 * `claude-opus-5` from `openai/gpt-oss-120b` meant reading a
 * hyphenated slug at 11px — and the slugs that matter most are the ones that
 * look most alike (`kimi-k2-thinking` vs `kimi-k2-thinking-turbo`,
 * `moonshotai/kimi-k2-instruct-0905` vs `kimi-k2-0905-preview`).
 *
 * FAMILY, NOT SERVING VENDOR — and the distinction is load-bearing here in a
 * way it is nowhere else in this codebase. `LaunchModelCatalogEntry.provider`
 * answers "who SERVES this", which is the right question for credentials and
 * the wrong one for an icon: six of this node's rows are served by Groq, so
 * keying the mark on `provider` would draw the SAME bolt on Llama, Qwen,
 * DeepSeek, GPT-OSS and Kimi-on-Groq — five different models, one icon, which
 * is exactly the "same blob" failure `kind-art.ts` documents at length. The
 * user named four FAMILIES ("kimi grok claude gpt"), so the family is what the
 * icon carries and the serving vendor rides in the label beside it.
 *
 * WHY THE ID IS READ BEFORE THE CATALOG. The id is the stronger evidence, and
 * the catalog is the fallback — not the other way round. A catalog row answers
 * "who serves this", and for the six Groq-hosted rows that answer cannot name a
 * family at all; the id can, in every one of those six cases. The catalog is
 * still needed, because it resolves the ids that ARE silent about their family,
 * and it must not be the only source either: the UI's own model catalog is
 * delta-stored, a member may ADD a model in the browser that no build here has
 * ever seen, and `CatalogModel.provider` is a free string there. A model nobody
 * listed still deserves its family's mark.
 */

import { LAUNCH_MODEL_CATALOG } from '@tm8/contract';

export type ModelFamily =
  | 'claude'
  | 'gpt'
  | 'kimi'
  | 'llama'
  | 'qwen'
  | 'deepseek'
  | 'grok'
  | 'gemini'
  | 'unknown';

/**
 * ORDER IS THE WHOLE ALGORITHM, and two pairs here are genuinely ambiguous.
 *
 * `grok` before `gpt`/`groq`: xAI's model is `grok-*` and Groq the host is
 * `groq` — one transposed letter apart, and both reach `codex`. Matching `grok`
 * first on the exact prefix keeps a Grok model from ever drawing the host's
 * bolt.
 *
 * `kimi` before `moonshot`: Groq serves Kimi as `moonshotai/kimi-k2-instruct-…`,
 * so the id carries BOTH vendor names. The family is Kimi in either spelling —
 * `moonshotai/` is the namespace of whoever published the weights, not a
 * different model.
 *
 * `openai/gpt-oss-*` matches `gpt` and NOT the serving host, for the same
 * reason: OpenAI's open-weight model is a GPT wherever it runs.
 */
const FAMILY_RULES: readonly (readonly [ModelFamily, readonly string[]])[] = [
  ['claude', ['claude', 'anthropic', 'fable', 'opus', 'sonnet', 'haiku']],
  ['grok', ['grok-', 'grok/', 'xai']],
  ['kimi', ['kimi', 'moonshot']],
  ['deepseek', ['deepseek']],
  ['qwen', ['qwen']],
  ['llama', ['llama']],
  ['gemini', ['gemini']],
  ['gpt', ['gpt', 'o1-', 'o3-', 'o4-', 'codex', 'astra']],
];

/** The family a model id belongs to, catalog first and the id itself after. */
export function modelFamilyOf(model: string | null | undefined): ModelFamily {
  if (!model) return 'unknown';
  const id = model.toLowerCase();

  for (const [family, needles] of FAMILY_RULES) {
    if (needles.some((needle) => id.includes(needle))) return family;
  }

  /*
   * The id said nothing, so fall back to the catalog's SERVING vendor — which
   * names a family only where vendor and family coincide. `anthropic` and
   * `openai` are both a family AND a host, so they are safe to read straight;
   * `moonshot` means Kimi. `groq` is deliberately absent: it says who runs the
   * machine, never which model, so a Groq row the rules could not place stays
   * `unknown` rather than being drawn as something it is not.
   */
  const entry = LAUNCH_MODEL_CATALOG.find((row) => row.model.toLowerCase() === id);
  if (entry) {
    if (entry.provider === 'anthropic') return 'claude';
    if (entry.provider === 'openai') return 'gpt';
    if (entry.provider === 'moonshot') return 'kimi';
  }
  return 'unknown';
}

/** How the family is named to a reader. Never a slug. */
export const MODEL_FAMILY_LABEL: Record<ModelFamily, string> = {
  claude: 'Claude',
  gpt: 'GPT',
  kimi: 'Kimi',
  llama: 'Llama',
  qwen: 'Qwen',
  deepseek: 'DeepSeek',
  grok: 'Grok',
  gemini: 'Gemini',
  unknown: 'Model',
};

/**
 * Who SERVES this model, when the catalog knows. `null` for a model the catalog
 * does not list — which is not a failure, just an absent second fact.
 */
export function modelServedBy(model: string | null | undefined): string | null {
  if (!model) return null;
  const id = model.toLowerCase();
  const entry = LAUNCH_MODEL_CATALOG.find((row) => row.model.toLowerCase() === id);
  if (!entry) return null;
  return SERVING_VENDOR_LABEL[entry.provider] ?? entry.provider;
}

const SERVING_VENDOR_LABEL: Record<string, string> = {
  anthropic: 'Anthropic',
  openai: 'OpenAI',
  moonshot: 'Moonshot',
  groq: 'Groq',
};

/**
 * The one line that goes beside the mark, and the mark's accessible name.
 *
 * It names the serving vendor ONLY when that vendor is not the family's own
 * home — "Claude · Anthropic" is noise, "Kimi · served by Groq" is the fact a
 * reader cannot get anywhere else on the row.
 */
/**
 * The serving vendor, but ONLY when it is not the family's own home — the
 * half of `modelMarkLabel` a UI wants when it is already printing the model's
 * name and needs just the surprising part. `null` for Claude-on-Anthropic,
 * `'Groq'` for `moonshotai/kimi-k2-instruct-0905`.
 */
export function modelServedNote(model: string | null | undefined): string | null {
  const family = modelFamilyOf(model);
  const served = modelServedBy(model);
  if (!served) return null;
  const home =
    (family === 'claude' && served === 'Anthropic') ||
    (family === 'gpt' && served === 'OpenAI') ||
    (family === 'kimi' && served === 'Moonshot');
  return home ? null : served;
}

export function modelMarkLabel(model: string | null | undefined): string {
  const name = MODEL_FAMILY_LABEL[modelFamilyOf(model)];
  const served = modelServedNote(model);
  return served ? `${name} · served by ${served}` : name;
}
