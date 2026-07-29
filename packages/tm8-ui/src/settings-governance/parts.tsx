/**
 * The small shared atoms of the three T2 governance screens.
 *
 * These exist so the honesty treatments are applied ONCE. The failure they
 * prevent is the one this program keeps re-shipping in new clothes: a screen
 * with four places that render an unread value, three of which use the hollow
 * treatment and one of which prints a plausible default. Routing every unread
 * value through `KnownText`/`KnownRow` makes that impossible to do by accident —
 * the `Known<T>` type has no member a component can render as a bare value.
 */
import type { ReactNode } from 'react';
import { DisabledAction, HollowInline, type UnavailableReason } from '../panels';
import { Eyebrow } from '../kit';
import type { Known } from './governance-model';

/**
 * A card: the shell every region of T2 is drawn in (oracle L151, L189, L231,
 * L245, L399, L429, L476, L503, L564, L592). `tone="node"` is the DARK card the
 * oracle uses for node-admin regions — half the point of T2-2 is that the
 * space-side and node-side truths never share a surface treatment.
 */
export function GovCard({
  title,
  subtitle,
  tone = 'space',
  action,
  children,
  labelledBy,
}: {
  title?: ReactNode;
  subtitle?: ReactNode;
  tone?: 'space' | 'node';
  /** Header-right control. Usually a `RefusedControl`. */
  action?: ReactNode;
  children: ReactNode;
  labelledBy?: string;
}) {
  return (
    <section className={`gov-card gov-card--${tone}`} aria-labelledby={labelledBy}>
      {title !== undefined ? (
        <header className="gov-card__head">
          <span className="gov-card__title" id={labelledBy}>
            {title}
          </span>
          {subtitle !== undefined ? <span className="gov-card__sub">{subtitle}</span> : null}
          <span className="gov-card__spacer" />
          {action}
        </header>
      ) : null}
      {children}
    </section>
  );
}

/** The caption under a card, the oracle's own annotation voice (L186, L228…). */
export function CardNote({ children }: { children: ReactNode }) {
  return <p className="gov-note">{children}</p>;
}

/**
 * A control that exists, is focusable, states its reason, and cannot be
 * performed. The whole lane's default: of the ~20 verbs the T2 frames draw,
 * exactly two have an executor.
 */
export function RefusedControl({
  reason,
  glyph,
  children,
  emphasis = 'quiet',
}: {
  reason: UnavailableReason;
  glyph?: string;
  children: ReactNode;
  /** `primary` renders the brass create-chip shape the oracle draws (L156). */
  emphasis?: 'quiet' | 'primary';
}) {
  return (
    <span className={`gov-refused gov-refused--${emphasis}`}>
      <DisabledAction reason={reason}>
        {glyph ? <span aria-hidden>{glyph} </span> : null}
        {children}
      </DisabledAction>
    </span>
  );
}

/**
 * Renders a `Known<T>` as text, or the hollow treatment with its reason.
 *
 * `HollowInline` carries the reason through `title` AND a hidden element that
 * assistive tech actually reads — copied from `HollowValue.tsx`'s own note that
 * `title` alone is not reliably announced.
 */
export function KnownText<T>({
  value,
  render,
  hollow = '—',
}: {
  value: Known<T>;
  render: (value: T) => ReactNode;
  /** What stands in for the missing value. Never `0`, never an empty string. */
  hollow?: ReactNode;
}) {
  if (value.known) return <>{render(value.value)}</>;
  const caption = value.reason.remedy
    ? `${value.reason.cause} — ${value.reason.remedy}`
    : value.reason.cause;
  return <HollowInline caption={caption}>{hollow}</HollowInline>;
}

/** A label + value row, the T2 field-grid anatomy (oracle L217-225). */
export function FieldRow({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="gov-field">
      <span className="gov-field__label">{label}</span>
      <span className="gov-field__value">{children}</span>
    </div>
  );
}

/**
 * A region whose CONTENT could not be read — distinct from a region that is
 * empty. It keeps the region's shape (so the reader learns what would be here)
 * and states the cause where the rows would be.
 *
 * This is the treatment that stops T2-2's node registry card from reading as
 * "this node has no projects", which is a claim nobody measured.
 */
export function UnreadRegion({ reason }: { reason: UnavailableReason }) {
  return (
    <div className="gov-unread" data-testid="unread-region">
      <span className="gov-unread__cause">{reason.cause}</span>
      {reason.remedy ? <span className="gov-unread__remedy">{reason.remedy}</span> : null}
    </div>
  );
}

/** A measured-empty region. Says what it looked for and that it found none. */
export function EmptyRegion({ children }: { children: ReactNode }) {
  return (
    <div className="gov-empty" data-testid="empty-region">
      {children}
    </div>
  );
}

/** Section eyebrow — re-exported through the kit so the type scale is shared. */
export function GovEyebrow({ children }: { children: ReactNode }) {
  return <Eyebrow faint>{children}</Eyebrow>;
}

/** A three-state region: loading, failed, or its rows. */
export function LoadRegion<T>({
  state,
  children,
  what,
}: {
  state: { phase: 'loading' } | { phase: 'ready'; value: T } | { phase: 'failed'; message: string };
  children: (value: T) => ReactNode;
  /** Named in both the loading and the failure copy ("linked projects"). */
  what: string;
}) {
  if (state.phase === 'loading') {
    return (
      <div className="gov-loading" data-testid="loading-region" aria-live="polite">
        Reading {what}…
      </div>
    );
  }
  if (state.phase === 'failed') {
    return (
      <UnreadRegion
        reason={{ cause: `${what} could not be read`, remedy: state.message }}
      />
    );
  }
  return <>{children(state.value)}</>;
}
