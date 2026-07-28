import { useId, type ReactNode } from 'react';

/**
 * DISABLED-WITH-REASON — the L6 primitive.
 *
 * "Unavailable ≠ invisible." A deferred feature or an op the facade cannot
 * perform renders as a visible, labelled, unclickable affordance carrying its
 * reason. Never hidden (the user would not learn the feature exists), never
 * silently inert (the user would think the app is broken).
 *
 * TWO FORMS, both from T1-4:
 *   · tooltip — for icon buttons, where there is no room for prose;
 *   · inline  — a caption under the control, where there is.
 *
 * ACCESSIBILITY, and why this is NOT a `disabled` attribute: a natively
 * disabled button is removed from the tab order, so a keyboard-only user can
 * never reach it and therefore can never learn WHY it is unavailable — which
 * defeats the entire point of the treatment. These controls are
 * `aria-disabled` and focusable, with the reason wired through
 * `aria-describedby`, so the reason is announced on focus. The reason text is
 * always in the DOM (the tooltip is hidden with opacity/visibility, never
 * `display:none`, which would drop it from the accessibility tree too).
 */

export interface UnavailableReason {
  /** Bold cause line: what is true. Name numbers ("3 panels pinned"). */
  cause: string;
  /** Mono remedy line: the next step or the named constraint. Optional. */
  remedy?: string;
}

/**
 * Tooltip form. `label` is the accessible name and is REQUIRED — an icon
 * button without one is a type error here for the same reason it is in
 * kit/IconBtn.
 */
export function DisabledIconControl({
  label,
  reason,
  glyph,
  children,
}: {
  label: string;
  reason: UnavailableReason;
  /** Decorative glyph; the accessible name comes from `label`. */
  glyph?: string;
  /** Optional visible text beside the glyph. */
  children?: ReactNode;
}) {
  const tipId = useId();
  return (
    <span
      className="hon-disabled hon-disabled--tooltip"
      role="button"
      aria-disabled="true"
      aria-label={label}
      aria-describedby={tipId}
      tabIndex={0}
      data-testid="disabled-with-reason"
    >
      {glyph ? <span aria-hidden>{glyph}</span> : null}
      {children}
      <ReasonTip id={tipId} reason={reason} />
    </span>
  );
}

/**
 * Inline-caption form. The control keeps its brass identity at .45 so the
 * verb stays legible as a thing that exists; the caption below carries the
 * reason in the mono remedy voice.
 */
export function DisabledAction({
  reason,
  children,
  label,
}: {
  reason: UnavailableReason;
  children: ReactNode;
  /** Accessible name; defaults to the visible label. */
  label?: string;
}) {
  const captionId = useId();
  return (
    <span className="hon-disabled-group">
      <span
        className="hon-disabled hon-disabled--inline"
        role="button"
        aria-disabled="true"
        aria-label={label}
        aria-describedby={captionId}
        tabIndex={0}
        data-testid="disabled-with-reason"
      >
        {children}
      </span>
      <span className="hon-caption" id={captionId}>
        {reason.cause}
        {reason.remedy ? ` — ${reason.remedy}` : null}
      </span>
    </span>
  );
}

function ReasonTip({ id, reason }: { id: string; reason: UnavailableReason }) {
  return (
    <span className="hon-tip" id={id} role="tooltip">
      <span className="hon-tip__cause">{reason.cause}</span>
      {reason.remedy ? <span className="hon-tip__remedy">{reason.remedy}</span> : null}
    </span>
  );
}

/**
 * Splits a single reason sentence into the canvas's two-line shape. Reasons
 * authored as one string (the §10.7 register's, the fixtures') still render
 * in the cause/remedy voice: everything up to the first em-dash or colon is
 * the cause, the rest is the remedy.
 */
export function toReason(text: string): UnavailableReason {
  const m = /^(.*?)\s*[—:]\s*(.+)$/s.exec(text);
  if (!m || !m[1] || !m[2]) return { cause: text };
  return { cause: m[1], remedy: m[2] };
}

/**
 * THE ENABLED-INERT REASON (R5 #9, the F6/X4 class).
 *
 * A verb whose handler is not wired renders DISABLED-WITH-REASON, never as a
 * live control that silently does nothing. An enabled button that does not
 * respond is worse than a disabled one: the user cannot tell a broken app
 * from an unimplemented feature, and they will click it again.
 *
 * This is the same law as L6 — never advertise an action the facade cannot
 * perform — applied one layer in: never advertise an action THIS BUILD cannot
 * dispatch. The check is structural (is there a handler?) so it cannot drift
 * out of sync with what is actually wired.
 */
export const NOT_WIRED_REASON: UnavailableReason = {
  cause: 'This action isn’t connected yet',
  remedy: 'the verb exists and its screen does not dispatch it in this build',
};

/**
 * THE CHECKING STATE — waiting for capabilities is not the same as being
 * refused them (fe->a1c 63; D6/D39 arriving at the capability layer).
 *
 * Capabilities ride on EntityDetail, so a row whose detail has not been pulled
 * yet has UNKNOWN permissions. Rendering that in the refusal form is a facet
 * collapse: "we haven't asked yet" and "you may not" are different facts, and
 * at a glance a transient refusal is indistinguishable from a permanent one —
 * the viewer concludes they lack a permission they may well have.
 *
 * So this is deliberately NOT `DisabledAction`/`DisabledIconControl`. It is
 * the LOADING vocabulary: hollow treatment, its own copy, and no `role=button`
 * — because there is no refusal here to announce, only a fact that has not
 * arrived. It resolves on its own, which is exactly what the copy promises.
 *
 * The discrimination is structural, and both halves are available at the prop
 * boundary: NO capability source at all is a wiring gap (NOT_WIRED_REASON);
 * a source that returns `undefined` is a row that has not loaded yet (this).
 */
export function CheckingPermission({ label, glyph }: { label: string; glyph?: string }) {
  return (
    <span
      className="hon-checking"
      aria-live="polite"
      aria-label={`${label} — checking permissions`}
      data-testid="checking-permission"
      title={CHECKING_CAPTION}
    >
      {glyph ? <span aria-hidden>{glyph}</span> : null}
    </span>
  );
}

export const CHECKING_CAPTION = 'Checking permissions… this entity hasn’t finished loading';
