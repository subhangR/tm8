/**
 * WHICH MODELS THE CHAT OFFERS, AND WHAT IT SAYS ABOUT EACH.
 *
 * ── THE SEAM ────────────────────────────────────────────────────────────────
 *
 * This module is the ONE place the chat's model picker gets its list, and it is
 * written to be replaced from the top. `chatModelChoices` takes an array of
 * `ChatModelSource` — four plain fields, no catalog type, no import from the
 * contract — and returns what the picker renders. It does not read
 * `LAUNCH_MODEL_CATALOG`, it does not read localStorage, and it does not know
 * that a catalog exists.
 *
 * Today its caller (`ChatHomeSurface`) fills that array from
 * `domain/model-catalog`, which is the contract's nine built-ins plus this
 * browser's own additions. When model DISCOVERY lands — DESIGN 4, task
 * `01a027a9-56e0-700c-a0a6-23419f5172eb`, "kill the 9 hardcoded entries" —
 * the change is to that ONE call site: hand this function a discovered list
 * instead of a catalog-derived one. Nothing in this file, in `ComposerSelect`,
 * or in `ChatHomeScreen` has to move, because none of them can tell where the
 * array came from.
 *
 * NINE HARDCODED ENTRIES IS TEMPORARY BY DECISION, NOT BY DESIGN. The product
 * ruling is discovery, not curation: the picker should offer what the installed
 * agent CLI actually supports. This PR does not build the discovery mechanism —
 * that is DESIGN 4's, it is blocked on the harness registry, and a second
 * discovery path here would collide with it. What this PR owes DESIGN 4 is a
 * list-shaped hole to drop into, and this is it.
 *
 * ── WHY SUITABILITY IS PART OF THE SHAPE ────────────────────────────────────
 *
 * The curation being removed was deliberate — the design notes call it
 * "concrete over configurable". Offering everything means a person can pick a
 * model that will not do the job, with nothing on the row to warn them. The
 * answer to that is not fewer models; it is better labelling, which is exactly
 * what DESIGN 6 does for harnesses when it tiers them A/B/C by capability.
 *
 * So every choice carries a `suitability`, and one of its two dimensions is
 * populated TODAY:
 *
 *   · `unavailable` — a hard capability fact this surface can actually check:
 *     chat launches claude-code models, so a model that launches under another
 *     tool cannot run here. Measured, not guessed, and the same rule the server
 *     enforces on the way in. Rows carrying it are shown with their reason
 *     rather than hidden.
 *   · `tier` — the soft "is this a good fit for the job" signal, DESIGN 6's
 *     A/B/C generalised from harnesses to models. It is `null` on every entry
 *     and this file never sets it, because NOTHING IN TM8 MEASURES IT YET.
 *     A field left null is a slot; a field filled with a guess is a lie
 *     wearing the authority of a label. Whoever lands the measurement fills
 *     this in and the picker starts rendering it — see `tierNote` below, which
 *     is already wired through to the row and already renders nothing.
 */

/**
 * What this module needs to know about a model. Four strings — deliberately
 * NOT `CatalogModel`, so a discovered list does not have to pretend to be a
 * catalog entry to be offered here.
 */
export interface ChatModelSource {
  model: string;
  label: string;
  /** The agent CLI this model launches under. The one capability fact we have. */
  agentTool: string;
  /** Shown as the row's second line when the model is offerable. */
  provider?: string;
}

/**
 * DESIGN 6's capability tier, generalised from harnesses to models. Unpopulated
 * — see the header. Kept as a named type rather than an inline `null` so that
 * filling it in is a change to one declaration and not a search.
 */
export type ChatModelTier = 'A' | 'B' | 'C';

export interface ChatModelSuitability {
  /**
   * Why this model cannot run in chat, in one plain sentence, or null when it
   * can. Populated today.
   */
  unavailable: string | null;
  /** How well it fits the work. NOT POPULATED — nothing measures it yet. */
  tier: ChatModelTier | null;
}

export interface ChatModelChoice {
  model: string;
  label: string;
  /** The row's second line when the model is offerable. */
  hint?: string;
  suitability: ChatModelSuitability;
}

/**
 * The one agent tool chat can launch.
 *
 * NOT A CURATION AND NOT A PREFERENCE — it is what the server does. Both
 * `chat.threads.start` and `messages.post` refuse a model that launches under
 * anything else, with this same sentence, because a chat thread's runtime is a
 * claude-code process and its resume path is that provider's own conversation
 * id. Stated here so the picker refuses in the composer instead of letting the
 * refusal arrive from the server after the person has already sent.
 */
const CHAT_AGENT_TOOL = 'claude-code';

/**
 * A person's word for an agent tool. Falls back to the raw id rather than to
 * something invented, because a tool this UI has not been taught is a real
 * possibility once discovery lands, and "launches via cursor" is a more useful
 * sentence than "launches via another tool".
 */
function toolName(agentTool: string): string {
  if (agentTool === 'claude-code') return 'Claude Code';
  if (agentTool === 'codex') return 'Codex';
  return agentTool;
}

/**
 * The tier's row text. Renders nothing while tiers are unmeasured, which is
 * every entry today — the call site is wired so that landing the measurement
 * is a change here and nowhere else.
 */
export function tierNote(tier: ChatModelTier | null): string | null {
  if (tier === null) return null;
  return `Tier ${tier}`;
}

/**
 * Every model the source offers, in the source's own order, each labelled with
 * what this surface knows about it.
 *
 * NOTHING IS DROPPED. A model that cannot run here comes back with its reason
 * rather than being filtered out — the picker renders it unpickable and says
 * why, and the person learns the shape of what is available instead of
 * wondering where an entry went.
 */
export function chatModelChoices(source: readonly ChatModelSource[]): ChatModelChoice[] {
  return source.map((entry) => {
    const runnable = entry.agentTool === CHAT_AGENT_TOOL;
    const suitability: ChatModelSuitability = {
      unavailable: runnable
        ? null
        : `Chat runs ${toolName(CHAT_AGENT_TOOL)} models — this one launches via ${toolName(entry.agentTool)}`,
      tier: null,
    };
    const note = tierNote(suitability.tier) ?? entry.provider;
    return {
      model: entry.model,
      label: entry.label,
      ...(note ? { hint: note } : {}),
      suitability,
    };
  });
}

/** True when at least one offered model can actually run here. */
export function hasRunnableModel(choices: readonly ChatModelChoice[]): boolean {
  return choices.some((choice) => choice.suitability.unavailable === null);
}

/** The first model that can run, or null — the honest default for a new thread. */
export function firstRunnableModel(choices: readonly ChatModelChoice[]): ChatModelChoice | null {
  return choices.find((choice) => choice.suitability.unavailable === null) ?? null;
}
