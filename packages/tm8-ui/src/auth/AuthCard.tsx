/**
 * THE CARD GRAMMAR — "One 380px card carries every moment" (oracle L22).
 *
 * The T3 board's whole thesis is that seventeen auth moments are ONE component
 * with different contents. These are that component's parts. Every literal
 * below cites the oracle line it was extracted from; none of them was
 * eyeballed (brief §2.1).
 *
 * WHY THE REFUSAL SKIN LIVES HERE AND NOT IN panels/honesty/. The honesty
 * vocabulary ships two forms: a tooltip for icon buttons and an inline caption
 * whose control keeps a BRASS identity at .45 (honesty.css). The T3 primary is
 * an INK chip (oracle L43: `background:#23201B;color:#F4F2EC`), so wearing the
 * brass skin would make every auth screen diverge from the canvas at its most
 * prominent element. `AuthAction` is therefore treatment A — same law, same
 * D28 mechanics (role=button, aria-disabled, tabIndex 0, aria-describedby,
 * reason always in the DOM, never natively `disabled`), same D32 opacity (.45,
 * the inline-caption value) — worn over the oracle's own button geometry. It is
 * NOT a fourth treatment; T4's matrix rule is intact. FLAGGED IN THE HANDOVER
 * as a ruling I made alone, because "same treatment, different skin" is exactly
 * the kind of claim that should be ratified rather than assumed.
 */
import { useId, type ReactNode } from 'react';
import type { UnavailableReason } from '../panels/honesty/DisabledWithReason';

/* ── stage ─────────────────────────────────────────────────────────────── */

/**
 * The full-bleed auth stage. The oracle draws each frame as a 500×620 board
 * (L35 et al) — that box is CANVAS FURNITURE, the specimen viewport, not
 * product (the D47 precedent: the layout A|B|C picker is furniture too). What
 * IS product is its contents: paper ground, a 46px chrome bar, the card
 * centred.
 */
export function AuthStage({
  meta,
  children,
  testid,
}: {
  /** Right-hand chrome line — mono 10px, --pn-ink-4 (oracle L36). */
  meta?: string;
  children: ReactNode;
  testid?: string;
}) {
  return (
    <div className="auth-stage" data-testid={testid}>
      {/* oracle L36: height 46, padding 0 18px, "◈ tm8" mono 13/600 brass */}
      <div className="auth-stage__bar">
        <span className="auth-stage__brand">◈ tm8</span>
        {meta ? <span className="auth-stage__meta">{meta}</span> : null}
      </div>
      <div className="auth-stage__body">{children}</div>
    </div>
  );
}

/** Card widths the oracle actually draws. Nothing else is legal. */
export type AuthCardWidth =
  | 'card' /* 380 — L37, the default card grammar */
  | 'narrow' /* 340 — L177, signed out */
  | 'mid' /* 360 — L251, dead invite; L352, gateway */
  | 'wide' /* 400 — L432, tokens */
  | 'modal'; /* 350 — L160/L287/L305, the over-workspace dialogs */

/**
 * The card. --pn-surface over --pn-line-2, r14 (--pn-r-lg), --pn-sh-pop.
 *
 * DIVERGENCE, RULED: the oracle draws three different card shadows —
 * `0 12px 34px rgba(40,34,24,.10)` on the standalone cards (L37), `.22` on the
 * modals (L160), `.18` on the coach-marks (L230). `--pn-sh-pop` is the same
 * geometry at `.14`. The token wins: three alphas of one shadow is drift in
 * the source, not three intentions, and inlining rgba() colour literals to
 * chase it would put un-tokenised colour back into a package whose §14 guard
 * exists to prevent exactly that (the guard only scans hex, so this would have
 * passed — which is why it is a ruling and not an accident).
 */
export function AuthCard({
  width = 'card',
  children,
  className,
  testid,
}: {
  width?: AuthCardWidth;
  children: ReactNode;
  className?: string;
  testid?: string;
}) {
  return (
    <div
      className={`auth-card auth-card--${width}${className ? ` ${className}` : ''}`}
      data-testid={testid}
    >
      {children}
    </div>
  );
}

/* ── type ──────────────────────────────────────────────────────────────── */

/** Mono 10px/600/.12em --pn-ink-3 (oracle L38). D5: the literal stays. */
export function AuthEyebrow({ children, tone }: { children: ReactNode; tone?: AuthTone }) {
  return <span className={`auth-eyebrow${tone ? ` auth-eyebrow--${tone}` : ''}`}>{children}</span>;
}

/**
 * Newsreader 23px/500/1.18 (oracle L39). The 21px variant (L162, L179, L253)
 * is `size="sm"` — two sizes, both drawn, no third.
 */
export function AuthTitle({ children, size = 'lg' }: { children: ReactNode; size?: 'lg' | 'sm' }) {
  return <div className={`auth-title auth-title--${size}`}>{children}</div>;
}

/** 13px/1.5/--pn-ink-2 (oracle L40); `sm` = 12.5px (L163, L180, L205). */
export function AuthBody({ children, size = 'lg' }: { children: ReactNode; size?: 'lg' | 'sm' }) {
  return <div className={`auth-body auth-body--${size}`}>{children}</div>;
}

/** 11px --pn-ink-4, centred (oracle L44). The card's closing whisper. */
export function AuthFootnote({ children }: { children: ReactNode }) {
  return <div className="auth-footnote">{children}</div>;
}

/** 1px --pn-line (oracle L122). BOUNDS the card's sections — D-law 4's line. */
export function AuthRule() {
  return <div className="auth-rule" role="separator" />;
}

/* ── steps ─────────────────────────────────────────────────────────────── */

/** Three 6px dots, gap 4, brass filled / --pn-line-2 empty (oracle L38). */
export function AuthSteps({ of, at }: { of: number; at: number }) {
  return (
    <span className="auth-steps" aria-label={`step ${at} of ${of}`}>
      {Array.from({ length: of }, (_, i) => (
        <span key={i} className={`auth-step${i < at ? ' auth-step--on' : ''}`} aria-hidden />
      ))}
    </span>
  );
}

/* ── fields ────────────────────────────────────────────────────────────── */

/**
 * A field. The oracle draws inputs as STATIC boxes with a caret glyph — it is
 * a canvas, so it has no live input.
 *
 * These ARE live `<input>`s. The reasoning: a static div would be
 * un-focusable, un-announced and un-typeable, which is worse than useless to a
 * keyboard or screen-reader user, and R7's target is a control that PRETENDS
 * TO ACT — typing into a field that submits nowhere claims nothing, while the
 * submit button beside it refuses out loud and names why. The specimen value
 * seeds `defaultValue` so the canvas diff still compares like with like.
 */
export function AuthField({
  label,
  value,
  onChange,
  hint,
  mono,
  type = 'text',
  state = 'idle',
  trailing,
  placeholder,
  readOnly,
}: {
  label: string;
  value?: string;
  /**
   * Present ⇒ the field is CONTROLLED and the caller owns the value (the
   * gate's real credential fields). Absent ⇒ `value` seeds `defaultValue`, so
   * the specimen frames still render the oracle's strings for a canvas diff.
   * One prop distinguishes the two, and there is no third state.
   */
  onChange?: (value: string) => void;
  hint?: ReactNode;
  /** Mono 11.5px — the token/endpoint fields (oracle L117, L290). */
  mono?: boolean;
  type?: 'text' | 'password';
  /** `focus` = the brass ring the oracle draws on the active field (L41). */
  state?: 'idle' | 'focus' | 'error';
  /** The "show" affordance on password fields (oracle L42). */
  trailing?: ReactNode;
  placeholder?: string;
  readOnly?: boolean;
}) {
  const id = useId();
  const hintId = `${id}-hint`;
  const controlled = onChange
    ? { value: value ?? '', onChange: (e: { target: { value: string } }) => onChange(e.target.value) }
    : { defaultValue: value };
  return (
    <div className="auth-field">
      <label className="auth-field__label" htmlFor={id}>
        {label}
      </label>
      <div className={`auth-field__box auth-field__box--${state}`}>
        <input
          id={id}
          className={`auth-field__input${mono ? ' auth-field__input--mono' : ''}`}
          type={type}
          {...controlled}
          placeholder={placeholder}
          readOnly={readOnly}
          aria-describedby={hint ? hintId : undefined}
        />
        {trailing}
      </div>
      {hint ? (
        <span className="auth-field__hint" id={hintId}>
          {hint}
        </span>
      ) : null}
    </div>
  );
}

/* ── actions ───────────────────────────────────────────────────────────── */

/** The functional ramp, whole. Every tone here has a token pair in tokens.css. */
export type AuthTone = 'block' | 'wait' | 'run' | 'info' | 'idle' | 'brand';

/**
 * THE PRIMARY. Ink chip: h34, --pn-ink over --pn-paper, r7, 12.5/600 (oracle
 * L43), hover `--pn-x-btn-ink-hover` (the measured #3A362E already tokenised
 * in canvas-extra.css for exactly this chip).
 *
 * `reason` present ⇒ the act has no executor ⇒ D28 refusal. `onClick` present
 * ⇒ a real, wired act. Requiring exactly one of the two IS the structural
 * check the brief asks for: there is no third state in which a button renders
 * enabled with no handler, because the type has no room for one.
 */
export function AuthAction(
  props: { children: ReactNode; size?: 'lg' | 'sm'; variant?: 'ink' | 'ghost' } & (
    | { reason: UnavailableReason; onClick?: never }
    | { onClick: () => void; reason?: never }
  ),
) {
  const { children, size = 'lg', variant = 'ink' } = props;
  const captionId = useId();
  const cls = `auth-btn auth-btn--${variant} auth-btn--${size}`;

  if (props.reason) {
    return (
      <span className="auth-btn-group">
        <span
          className={`${cls} auth-btn--refused`}
          role="button"
          aria-disabled="true"
          aria-describedby={captionId}
          tabIndex={0}
          data-testid="disabled-with-reason"
        >
          {children}
        </span>
        {/* T1-4's caption voice, matching honesty.css's .hon-caption (mono
            9.5px --pn-ink-3): cause, then the remedy after an em-dash. */}
        <span className="auth-caption" id={captionId}>
          {props.reason.cause}
          {props.reason.remedy ? ` — ${props.reason.remedy}` : null}
        </span>
      </span>
    );
  }

  return (
    <button type="button" className={cls} onClick={props.onClick}>
      {children}
    </button>
  );
}

/**
 * A refused MENU ROW / LIST ROW — the same law where a button chip would be
 * wrong shape (1p's rows, 1q's revoke links, 1m's server tiles).
 */
export function AuthRefusedRow({
  reason,
  className,
  children,
  label,
}: {
  reason: UnavailableReason;
  className?: string;
  children: ReactNode;
  /** Accessible name, when the visible content is not a clean label. */
  label?: string;
}) {
  const captionId = useId();
  return (
    <span className={`auth-refused-row${className ? ` ${className}` : ''}`}>
      <span
        className="auth-refused-row__control"
        role="button"
        aria-disabled="true"
        aria-label={label}
        aria-describedby={captionId}
        tabIndex={0}
        data-testid="disabled-with-reason"
      >
        {children}
      </span>
      <span className="auth-caption" id={captionId}>
        {reason.cause}
        {reason.remedy ? ` — ${reason.remedy}` : null}
      </span>
    </span>
  );
}

/* ── honesty banners ───────────────────────────────────────────────────── */

/**
 * The T1-4 honesty banner (oracle L138): tinted fill, tinted border, a glyph,
 * a bold lead and the consequence. Colour is NEVER alone — the word carries
 * the meaning and the tone is the second signal.
 */
export function AuthAlert({
  tone,
  glyph,
  lead,
  children,
}: {
  tone: AuthTone;
  glyph: string;
  lead?: string;
  children: ReactNode;
}) {
  return (
    <div className={`auth-alert auth-alert--${tone}`} role="status">
      <span className="auth-alert__glyph" aria-hidden>
        {glyph}
      </span>
      <span className="auth-alert__text">
        {lead ? <b className="auth-alert__lead">{lead}</b> : null}
        {children}
      </span>
    </div>
  );
}

/**
 * The server tile — glyph in a brass-soft square, name, mono meta (oracle
 * L105, L308). Sizes are the two the oracle draws: 34px on the login header,
 * 38px on the rail-tile preview.
 */
export function AuthServerTile({
  glyph,
  name,
  meta,
  size = 'md',
  tone = 'brand',
  trailing,
}: {
  glyph: string;
  name: string;
  meta?: ReactNode;
  size?: 'sm' | 'md' | 'lg';
  tone?: AuthTone;
  trailing?: ReactNode;
}) {
  return (
    <div className="auth-server">
      <span className={`auth-glyph auth-glyph--${size} auth-glyph--${tone}`} aria-hidden>
        {glyph}
      </span>
      <div className="auth-server__text">
        <span className="auth-server__name">{name}</span>
        {meta ? <span className="auth-server__meta">{meta}</span> : null}
      </div>
      {trailing ? (
        <>
          <span className="auth-spacer" />
          {trailing}
        </>
      ) : null}
    </div>
  );
}

/** Status dot + word. Never the dot alone — the tokens.css header's own law. */
export function AuthStatus({ tone, children }: { tone: AuthTone; children: ReactNode }) {
  return (
    <span className={`auth-status auth-status--${tone}`}>
      <span className="auth-dot" aria-hidden />
      {children}
    </span>
  );
}

/**
 * A SPECIMEN MARKER. Where a frame renders oracle numbers that read like
 * server facts ("4 attempts left", "2 spaces joined"), this says so in the
 * caption voice. Without it the honest screens would be the ones that LOOK
 * least trustworthy, because they would be indistinguishable from fabricated
 * ones — and the reader has no other way to tell.
 */
export function AuthSpecimenNote({ children }: { children: ReactNode }) {
  return (
    <span className="auth-caption auth-caption--specimen" data-testid="auth-specimen-note">
      {children}
    </span>
  );
}

/*
 * The local-account note (`AuthLocalNote`) lived here until Identity v2
 * Stage 1. It said the gate authenticated nobody to the server — true when
 * written, a lie in the other direction once `session.ts` started performing
 * auth.signup / auth.login / auth.logout for real. Deleted rather than
 * reworded: the honest disclosure now lives in the frames' own gate copy
 * (`specimen.ts` GATE COPY), which states what each verb actually does.
 */

/** The honesty banner for a credential failure. `role="status"` so it is announced. */
export function AuthFailureBanner({ children }: { children: ReactNode }) {
  return (
    <div className="auth-alert auth-alert--block" role="status">
      <span className="auth-alert__glyph" aria-hidden>
        ✕
      </span>
      <span className="auth-alert__text">{children}</span>
    </div>
  );
}

/** The caption voice as a standalone block (mono 9.5px --pn-ink-3). */
export function AuthCaption({ children }: { children: ReactNode }) {
  return <span className="auth-caption">{children}</span>;
}
