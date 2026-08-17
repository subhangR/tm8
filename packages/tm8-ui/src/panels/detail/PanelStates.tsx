import type { ReactNode } from 'react';
import { IconBtn } from '../../kit';

/**
 * PANEL STATES — part of the anatomy, not per-archetype decoration (T0-4
 * frame 7, T4's matrix). They live in the shared shell, so EVERY kind gets
 * every state by construction and no archetype can forget one.
 *
 * T4's binding rule: a surface may only COMPOSE these treatments — inventing
 * a new empty/error/stale rendering somewhere is a design bug.
 */

/**
 * LOADING — geometry-true skeletons, never a spinner and never a blank flash.
 * The chrome renders instantly (it does not depend on the read) and only the
 * body shows skeletons, so the panel's shape is correct before its content
 * arrives and nothing reflows when it does.
 */
export function LoadingBody() {
  return (
    <div className="pn-body pn-skeleton" data-testid="panel-loading" aria-busy="true">
      <span className="sr-only">Loading…</span>
      <div className="pn-skel pn-skel--pulse" style={{ width: '85%' }} />
      <div className="pn-skel pn-skel--pulse" style={{ width: '70%' }} />
      <div className="pn-skel" style={{ width: '78%' }} />
      <div className="pn-skel" style={{ width: '45%' }} />
      <div className="pn-skel pn-skel--card" />
      <div className="pn-skel pn-skel--card" />
    </div>
  );
}

/**
 * STALE-PIN — a pinned panel showing an older pull than the live content.
 * Both versions are stated, and one click reconciles. The body dims rather
 * than hides: what you pinned is still what you are looking at.
 */
export function StalePinBanner({
  pinnedVersion,
  liveVersion,
  onRepull,
}: {
  pinnedVersion: number;
  liveVersion: number;
  onRepull?: () => void;
}) {
  return (
    <div className="pn-drift" data-testid="panel-stale-pin">
      <span className="pn-drift__badge">{`⚠ v${pinnedVersion} pinned · content is v${liveVersion}`}</span>
      <span className="pn-drift__text">this pin shows an old pull</span>
      <span className="pn-head__spacer" />
      <button type="button" className="pn-btn pn-btn--primary" onClick={onRepull}>
        {`re-pull v${liveVersion} ▸`}
      </button>
    </div>
  );
}

/**
 * ERROR — contained, identified, retryable.
 * The boundary wraps the TAB BODY only: header, tabs and footer stay live so
 * close, pin and Esc keep working. The app never white-screens.
 */
export function ErrorBody({ errorText, onRetry }: { errorText?: string; onRetry?: () => void }) {
  return (
    <div className="pn-state" role="alert" data-testid="panel-error">
      <span className="pn-state__icon pn-state__icon--error" aria-hidden>
        ◍
      </span>
      <span className="pn-state__title">This panel hit an error</span>
      {errorText ? <code className="pn-state__code">{errorText}</code> : null}
      <button type="button" className="pn-btn" onClick={onRetry}>
        Retry
      </button>
      <span className="pn-state__caption">
        Errors stay inside the panel — the rest of the workspace keeps working. The app never
        white-screens.
      </span>
    </div>
  );
}

/**
 * PERMISSION-LOST — "the one state that must NOT explain itself."
 *
 * This replaces the WHOLE panel, chrome included, and that is the point:
 * leaking the title, the kind, or even existence-in-a-count is the failure
 * mode. The breadcrumb truncates to a dash, no status pill renders, no counts
 * render. The same rule holds elsewhere — a permission-lost entity is OMITTED
 * from palette results and EXCLUDED from counts, never shown as a locked row.
 */
export function PermissionLostPanel({ onClose }: { onClose?: () => void }) {
  return (
    <div className="pn-panel" data-testid="panel-permission-lost">
      <div className="pn-head">
        <div className="pn-crumb">…&nbsp;›&nbsp;—</div>
        <div className="pn-head__row">
          <span className="pn-head__glyph" aria-hidden>
            ◇
          </span>
          <span className="pn-head__title pn-head__title--absent">—</span>
          <span className="pn-head__spacer" />
          <IconBtn label="Close panel" danger onClick={onClose}>
            ✕
          </IconBtn>
        </div>
      </div>
      <div className="pn-state">
        <span className="pn-state__icon" aria-hidden>
          ⊘
        </span>
        <span className="pn-state__title">You can’t see this</span>
        <span className="pn-state__body">
          Access changed while this panel was open. Nothing about the entity — title, kind, counts —
          is shown.
        </span>
        <button type="button" className="pn-btn" onClick={onClose}>
          Close panel
        </button>
      </div>
      <div className="pn-foot">permission-lost · nothing leaks</div>
    </div>
  );
}

/**
 * TOMBSTONE — "soft-delete is a rendering, not a hole."
 * The corpse stays addressable: dashed border, struck title, who and when.
 * References to it from threads, rails and edges stay resolvable and labelled,
 * so nothing in the graph 404s.
 */
export function TombstoneBody({
  deletedBy,
  deletedAgo,
  canRestore,
  onRestore,
}: {
  deletedBy?: string;
  deletedAgo?: string;
  canRestore?: boolean;
  onRestore?: () => void;
}) {
  return (
    <div className="pn-state" data-testid="panel-tombstone">
      <span className="pn-state__icon pn-state__icon--dashed" aria-hidden>
        ◔
      </span>
      <span className="pn-state__title">
        {`Deleted${deletedBy ? ` by ${deletedBy}` : ''}${deletedAgo ? ` · ${deletedAgo}` : ''}`}
      </span>
      <span className="pn-state__body">
        Tombstones keep their place in threads, rails and feeds — references to this entity stay
        resolvable, labeled, and honest.
      </span>
      {canRestore ? (
        <button type="button" className="pn-btn pn-btn--primary" onClick={onRestore}>
          Restore ▸
        </button>
      ) : null}
    </div>
  );
}

/**
 * EMPTY — "teaches the grammar in place" (T4 C-1). Kind glyph, ONE sentence
 * naming BOTH gestures, one quiet action. No illustrations, no "all caught
 * up!" cheer — an empty region is a place to learn what goes there.
 */
export function EmptyBody({
  glyph = '◇',
  sentence,
  actionLabel,
  onAction,
}: {
  /** A character or a drawn mark — the empty state of a KIND draws its icon. */
  glyph?: ReactNode;
  sentence: string;
  actionLabel?: string;
  onAction?: () => void;
}) {
  return (
    <div className="pn-state pn-state--empty" data-testid="panel-empty">
      <span className="pn-state__icon" aria-hidden>
        {glyph}
      </span>
      <span className="pn-state__body">{sentence}</span>
      {actionLabel ? (
        <button type="button" className="pn-btn pn-btn--quiet" onClick={onAction}>
          {actionLabel}
        </button>
      ) : null}
    </div>
  );
}
