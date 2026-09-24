/**
 * WHICH PROMPT A SESSION WAS BOOTED WITH — the single source of truth for the
 * `promptVersion` stamped into every launch manifest (spec ca8d §6.3, c761 Q27:
 * tag, don't sequence).
 *
 * It exists so journals and first-read metrics can be split by the frame the
 * agent actually read, without holding the v2 rollout behind a clean
 * before/after window: c761's baseline is measured only on `promptVersion=1`
 * sessions, whatever else is running beside them.
 *
 * Distinct from `manifestVersion`, which versions the manifest DOCUMENT shape,
 * and from the `<tm8_system_prompt version="1.0">` attribute, which is a frame
 * detail the agent sees. This one is the analytics tag. Today every launch
 * gets "1"; the v2.0 frame adds `'2.0'` here and the Interaction Profile picks
 * between them — callers take the value from this module, never a literal.
 */
export const PROMPT_VERSIONS = ['1'] as const;

export type PromptVersion = (typeof PROMPT_VERSIONS)[number];

/** Today's frame: the v1 persona envelope composed by `composePrompt`. */
export const PROMPT_VERSION_V1: PromptVersion = '1';

/** What a launch is stamped with when nothing selects otherwise. */
export const DEFAULT_PROMPT_VERSION: PromptVersion = PROMPT_VERSION_V1;

export function isPromptVersion(value: unknown): value is PromptVersion {
  return typeof value === 'string' && (PROMPT_VERSIONS as readonly string[]).includes(value);
}
