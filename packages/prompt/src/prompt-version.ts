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
 * detail the agent sees. This one is the analytics tag. `'2'` is the shorter
 * worker frame of spec ca8d §2 (`composeWorkerPromptV2`); the Interaction
 * Profile picks between them (`promptVersionFor`) — callers take the value
 * from this module, never a literal.
 */
export const PROMPT_VERSIONS = ['1', '2'] as const;

export type PromptVersion = (typeof PROMPT_VERSIONS)[number];

/** Today's frame: the v1 persona envelope composed by `composePrompt`. */
export const PROMPT_VERSION_V1: PromptVersion = '1';

/** The v2.0 frame: five numbered rules plus the embedded context DTO (spec ca8d §2). */
export const PROMPT_VERSION_V2: PromptVersion = '2';

/**
 * What a launch is stamped with when nothing selects otherwise.
 *
 * Still v1, deliberately (spec ca8d §5, Q14): v2 flips to the default only
 * after the §6.2 behavioural evaluation passes, and v1 is then kept for one
 * release. Until then a session reaches v2 only through a profile that opts in.
 */
export const DEFAULT_PROMPT_VERSION: PromptVersion = PROMPT_VERSION_V1;

/**
 * The profile value that opts a launch into v2: `promptPolicy.kernelTemplate`.
 *
 * Selection rides the Interaction Profile (Q14) because a pin is immutable for
 * the session's whole life, so every session is on exactly one variant and the
 * A/B split falls out of which profile a teammate or space is given. The field
 * already exists (core default ships `tm8.core.v1`) and is a free string on
 * both validators, so opting in needs a profile draft, not a migration.
 */
export const KERNEL_TEMPLATE_V2 = 'tm8.core.v2';

/** The modes v2 covers (spec ca8d §5 scope). Every other mode stays on v1. */
export const PROMPT_V2_MODES: readonly string[] = ['worker', 'coordinated-worker'];

/**
 * The version a launch is booted with, from its mode and its resolved profile
 * snapshot. Reads `agentProjection.promptPolicy.kernelTemplate` tolerantly: an
 * absent or unknown template, or a mode outside v2's scope, is the default.
 */
export function promptVersionFor(input: {
  mode: string | null | undefined;
  profileSnapshot?: unknown;
}): PromptVersion {
  if (!input.mode || !PROMPT_V2_MODES.includes(input.mode)) return DEFAULT_PROMPT_VERSION;
  const at = (v: unknown, key: string): unknown =>
    typeof v === 'object' && v !== null ? (v as Record<string, unknown>)[key] : undefined;
  const template = at(at(at(input.profileSnapshot, 'agentProjection'), 'promptPolicy'), 'kernelTemplate');
  return template === KERNEL_TEMPLATE_V2 ? PROMPT_VERSION_V2 : DEFAULT_PROMPT_VERSION;
}

export function isPromptVersion(value: unknown): value is PromptVersion {
  return typeof value === 'string' && (PROMPT_VERSIONS as readonly string[]).includes(value);
}
