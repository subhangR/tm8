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
 * detail the agent sees. This one is the analytics tag. `'2'` is the layered
 * frame of spec ca8d §2 (`composePromptV2`); `promptVersionFor` picks
 * between them by mode — callers take the value from this module, never a
 * literal.
 */
export const PROMPT_VERSIONS = ['1', '2'] as const;

export type PromptVersion = (typeof PROMPT_VERSIONS)[number];

/** Today's frame: the v1 persona envelope composed by `composePrompt`. */
export const PROMPT_VERSION_V1: PromptVersion = '1';

/** The v2.0 frame: base + one role layer, plus the embedded context DTO (spec ca8d §2). */
export const PROMPT_VERSION_V2: PromptVersion = '2';

/**
 * What a NEW launch is stamped with: v2, for every agent mode.
 *
 * Subhang's ruling of 2026-10-13 ("everything to be using v2 prompts") made v2
 * the default ahead of the spec ca8d §6.2 evaluation that §5 had gated it on.
 * No Interaction Profile is consulted: `promptPolicy.kernelTemplate` no longer
 * selects the frame.
 */
export const DEFAULT_PROMPT_VERSION: PromptVersion = PROMPT_VERSION_V2;

/**
 * What a manifest WITHOUT a stamp reads as: v1.
 *
 * A manifest written before the stamp existed was booted on the v1 frame, and
 * re-rendering a stored manifest must reproduce what that session was given —
 * so an absent stamp is the legacy frame, never the current default.
 */
export const LEGACY_PROMPT_VERSION: PromptVersion = PROMPT_VERSION_V1;

/** The modes v2 covers: all five, since the layered prompt (task 01a0d465). */
export const PROMPT_V2_MODES: readonly string[] = [
  'worker',
  'coordinated-worker',
  'coordinator',
  'coordinated-coordinator',
  'dispatcher',
];

/**
 * The version a launch is booted with, from its mode: v2 for every mode v2
 * covers, and v1 for anything else (a mode with no v2 frame specified).
 */
export function promptVersionFor(input: { mode: string | null | undefined }): PromptVersion {
  return input.mode && PROMPT_V2_MODES.includes(input.mode) ? DEFAULT_PROMPT_VERSION : PROMPT_VERSION_V1;
}

export function isPromptVersion(value: unknown): value is PromptVersion {
  return typeof value === 'string' && (PROMPT_VERSIONS as readonly string[]).includes(value);
}
