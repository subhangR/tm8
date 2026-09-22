/**
 * THE DRAWN MARK FOR A MODEL FAMILY.
 *
 * Companion to `domain/model-family.ts`, which decides WHICH family a model id
 * belongs to; this file decides what that family looks like. Read that file's
 * header for why the mark keys on the family and not on the serving vendor.
 *
 * THE RULES ARE `kind-art.ts`'s, because the failure is the same one and it was
 * already diagnosed there: no two families may share a silhouette (guarded by
 * `model-mark.test.tsx`), the marks are semantic rather than decorative, and
 * they are PATHS in a square viewBox rather than characters — "typographic
 * arrows sit on their own font's baseline", so a glyph set lands at different
 * optical heights per platform and tofus differently on each.
 *
 * THE GRID: 24×24, stroked at ~1.7 in `currentColor` with round joins, nothing
 * filled but a deliberate dot. Filled marks read as "selected" beside stroked
 * ones, and tone is already how this UI says state.
 *
 * WHY THESE FIVE ARE NEW AND THREE ARE SHARED. Claude, Kimi and Groq already
 * had a mark in `settings-credentials/provider-presentation.tsx`, drawn for the
 * CREDENTIAL of that vendor. Those three are the same vendor identity on both
 * screens, so they moved here and that file now imports them — one crescent,
 * not two that drift. The rest are new because no credential exists for them:
 * a member connects a Groq key, never a "Llama" one.
 */

import type { ComponentType, SVGProps } from 'react';

import { MODEL_FAMILY_LABEL, modelFamilyOf, modelMarkLabel, type ModelFamily } from '../domain/model-family';

export type VendorMark = ComponentType<SVGProps<SVGSVGElement>>;

const markProps = {
  /*
   * A default size, not a fixed one: caller props are spread AFTER these, so
   * `<ModelMark size={16}/>` wins and a bare `<KimiMark/>` on a credential card
   * still lands at the 22px those cards were drawn for.
   */
  width: 22,
  height: 22,
  viewBox: '0 0 24 24',
  fill: 'none',
  xmlns: 'http://www.w3.org/2000/svg',
  'aria-hidden': true,
  focusable: 'false',
} as const;

/** Anthropic's burst. Shared with the Claude Code credential card. */
export function ClaudeMark(props: SVGProps<SVGSVGElement>) {
  return (
    <svg {...markProps} {...props}>
      <path d="M12 3v18M4.2 7.5l15.6 9M4.2 16.5l15.6-9" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
      <circle cx="12" cy="12" r="2.15" fill="currentColor" />
    </svg>
  );
}

/**
 * OpenAI's interlocking knot, reduced to a hexagonal ring with a woven centre.
 * Deliberately NOT the Codex hexagon-with-chevrons: that mark means the CLI, and
 * a GPT model reached through Groq is a GPT without being Codex.
 */
export function GptMark(props: SVGProps<SVGSVGElement>) {
  return (
    <svg {...markProps} {...props}>
      <path
        d="M12 3.4 19 7.45v8.1L12 19.6 5 15.55v-8.1L12 3.4Z"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinejoin="round"
      />
      <path
        d="M12 8.1v7.8M8.6 10.05l6.8 3.9M15.4 10.05l-6.8 3.9"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
      />
    </svg>
  );
}

/** A crescent — Kimi/Moonshot. Shared with the Kimi credential card. */
export function KimiMark(props: SVGProps<SVGSVGElement>) {
  return (
    <svg {...markProps} {...props}>
      <path
        d="M15.4 3.7a8.7 8.7 0 1 0 4.9 14.6A9.6 9.6 0 0 1 15.4 3.7Z"
        stroke="currentColor"
        strokeWidth="1.7"
        strokeLinejoin="round"
      />
      <circle cx="9.6" cy="10.3" r="1.15" fill="currentColor" />
    </svg>
  );
}

/** A bolt — Groq, whose one distinguishing claim is inference speed. */
export function GroqMark(props: SVGProps<SVGSVGElement>) {
  return (
    <svg {...markProps} {...props}>
      <path
        d="M13.6 3.2 6.4 13h4.6l-1.6 7.8L17.6 11H13l.6-7.8Z"
        stroke="currentColor"
        strokeWidth="1.7"
        strokeLinejoin="round"
      />
    </svg>
  );
}

/**
 * Meta's Llama — a llama's head in profile: two ears, a muzzle. An animal
 * silhouette is the one shape in this set that cannot be confused with any
 * geometric mark beside it, which is the point at 16px.
 */
export function LlamaMark(props: SVGProps<SVGSVGElement>) {
  return (
    <svg {...markProps} {...props}>
      <path
        d="M9 4.2 10.1 8M13.2 4.2 12.3 8"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinecap="round"
      />
      <path
        d="M9.5 7.6h3.4a3 3 0 0 1 3 3v3.2a2.6 2.6 0 0 1-2.6 2.6h-.7v3.4H9.9v-3.4H8.6A2.1 2.1 0 0 1 6.5 14V11a3.4 3.4 0 0 1 3-3.4Z"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinejoin="round"
      />
    </svg>
  );
}

/**
 * Qwen — two nested chevrons, the ideogram-stroke shape Alibaba's mark evokes,
 * pointing the opposite way to Codex's so the two never read as one.
 */
export function QwenMark(props: SVGProps<SVGSVGElement>) {
  return (
    <svg {...markProps} {...props}>
      <path
        d="M4.8 8.2 12 4.3l7.2 3.9M4.8 12.6 12 8.7l7.2 3.9M4.8 17l7.2-3.9 7.2 3.9"
        stroke="currentColor"
        strokeWidth="1.65"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

/** DeepSeek — a whale's back breaking a waterline, which is its own logo. */
export function DeepSeekMark(props: SVGProps<SVGSVGElement>) {
  return (
    <svg {...markProps} {...props}>
      <path
        d="M3.4 14.6c2.9 0 3.4-5.9 7.6-5.9 3.2 0 4.4 3.3 7 3.3 1.5 0 2.3-.7 2.6-1.4"
        stroke="currentColor"
        strokeWidth="1.7"
        strokeLinecap="round"
      />
      <path d="M4 18.6h16" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" />
      <circle cx="9.1" cy="11.5" r="1.05" fill="currentColor" />
    </svg>
  );
}

/** Grok — xAI's slashed X, drawn as two strokes that do not meet at centre. */
export function GrokMark(props: SVGProps<SVGSVGElement>) {
  return (
    <svg {...markProps} {...props}>
      <path d="M5 5.2 19 18.8M19 5.2 13.6 11" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
      <path d="M10.4 13 5 18.8" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
    </svg>
  );
}

/** Gemini — a four-point star. */
export function GeminiMark(props: SVGProps<SVGSVGElement>) {
  return (
    <svg {...markProps} {...props}>
      <path
        d="M12 3.25c.65 4.85 3.9 8.1 8.75 8.75-4.85.65-8.1 3.9-8.75 8.75C11.35 15.9 8.1 12.65 3.25 12 8.1 11.35 11.35 8.1 12 3.25Z"
        stroke="currentColor"
        strokeWidth="1.65"
        strokeLinejoin="round"
      />
      <circle cx="12" cy="12" r="1.35" fill="currentColor" />
    </svg>
  );
}

/**
 * A model with no family we recognise. A dashed ring rather than a filled
 * placeholder: it has to read as "not identified" and not as a ninth vendor.
 */
export function UnknownModelMark(props: SVGProps<SVGSVGElement>) {
  return (
    <svg {...markProps} {...props}>
      <circle
        cx="12"
        cy="12"
        r="7.6"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeDasharray="2.6 2.4"
      />
    </svg>
  );
}

export const MODEL_FAMILY_MARKS: Record<ModelFamily, VendorMark> = {
  claude: ClaudeMark,
  gpt: GptMark,
  kimi: KimiMark,
  llama: LlamaMark,
  qwen: QwenMark,
  deepseek: DeepSeekMark,
  grok: GrokMark,
  gemini: GeminiMark,
  unknown: UnknownModelMark,
};

export interface ModelMarkProps {
  /** The model id as the session or catalog records it. */
  model: string | null | undefined;
  /** Edge length in px. 16 on a list row, 22 on a card. */
  size?: number;
  className?: string;
  /**
   * Draw it as decoration only. Pass this where the model name is ALREADY
   * written next to the mark, so a screen reader is not told twice.
   */
  decorative?: boolean;
}

/**
 * The mark for a family that has ALREADY been resolved. The list panel uses
 * this one: `tile-badges.ts` resolves the family while it builds the slot, so
 * re-deriving it from the id at render time would run the rules twice per row
 * for the same answer.
 */
export function ModelFamilyMark({
  family,
  size = 16,
  className,
  label,
}: {
  family: ModelFamily;
  size?: number;
  className?: string;
  /** An accessible name, or nothing to draw it as decoration. */
  label?: string;
}) {
  const Mark = MODEL_FAMILY_MARKS[family];
  return (
    <Mark
      width={size}
      height={size}
      className={className}
      data-model-family={family}
      {...(label ? { 'aria-hidden': undefined, role: 'img', 'aria-label': label } : {})}
    />
  );
}

/**
 * The mark for a model, with the family (and the serving vendor, when that is
 * not the family's own home) as its accessible name.
 */
export function ModelMark({ model, size = 16, className, decorative = false }: ModelMarkProps) {
  const family = modelFamilyOf(model);
  const Mark = MODEL_FAMILY_MARKS[family];
  const label = modelMarkLabel(model);
  return (
    <Mark
      width={size}
      height={size}
      className={className}
      data-model-family={family}
      {...(decorative
        ? { 'aria-hidden': true, focusable: 'false' as const }
        : { 'aria-hidden': undefined, role: 'img', 'aria-label': label })}
    />
  );
}

export { MODEL_FAMILY_LABEL, modelFamilyOf, modelMarkLabel, type ModelFamily };
