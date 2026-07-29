/**
 * FLOW C · INVITES & ORIENTATION — 1h redeem · 1j orientation · 1i dead invite.
 *
 * Oracle DOM order is 1h → 1j → 1i, and it is kept: the flow reads
 * redeem → joined → orient, with the dead branch drawn last as "the branch".
 *
 * 1j IS THE ONE FULLY-BUILDABLE FRAME ON THE WHOLE BOARD. Three coach-marks,
 * a dismissal, "shown once, never again" — pure client state, no seam
 * capability required, nothing to refuse. Everything else in this flow needs
 * an invite read that no operation provides.
 */
import { useCallback, useState } from 'react';
import {
  AuthAction,
  AuthBody,
  AuthCard,
  AuthEyebrow,
  AuthField,
  AuthFootnote,
  AuthRule,
  AuthSpecimenNote,
  AuthStage,
  AuthTitle,
} from './AuthCard';
import { AuthOverlay } from './SignInFrames';
import { INVITE_DEAD, ORIENTATION, REDEEM, SERVER } from './specimen';
import { REDEEM_INVITE } from './reasons';
import type { FrameProps } from './types';

/**
 * Viewer-local, not per-space: orientation is shown to a PERSON once. Same
 * shape as the theme store's `tm8ui.theme` key, deliberately — one namespace.
 */
export const ORIENTATION_STORAGE_KEY = 'tm8ui.orientation.dismissed';

/** 1h — the invite redeem landing. Oracle L197–L212. */
export function FrameInviteRedeem(props: FrameProps) {
  return (
    <AuthStage meta={SERVER.joinMeta}>
      <AuthCard>
        <div className="auth-inviter">
          <span className="auth-avatar" aria-hidden>
            {REDEEM.inviterInitial}
          </span>
          <span className="auth-body auth-body--sm">
            <b>{REDEEM.inviter}</b> {REDEEM.invitedBy}
          </span>
        </div>
        <AuthTitle>{REDEEM.title}</AuthTitle>

        {/* oracle L204: the space row — brass dot, name, "space", then the
            server it belongs to, so the reader learns account ≠ space. */}
        <div className="auth-inset auth-inset--row">
          <span className="auth-dot auth-dot--brand" aria-hidden />
          <span className="auth-inset__name">{REDEEM.space}</span>
          <span className="auth-inset__kind">space</span>
          <span className="auth-spacer" />
          <span className="auth-glyph auth-glyph--xs auth-glyph--brand" aria-hidden>
            {SERVER.glyph}
          </span>
          <span className="auth-inset__meta">{SERVER.name}</span>
        </div>

        <AuthBody size="sm">{REDEEM.body}</AuthBody>
        <AuthSpecimenNote>
          the inviter, space and member counts are the oracle’s specimen values — no operation reads
          an invite before you join
        </AuthSpecimenNote>

        <AuthField label="YOUR NAME" value={REDEEM.name} state="focus" hint={REDEEM.nameHint} />
        <AuthField label="PASSWORD" type="password" value={REDEEM.password} />
        <AuthAction reason={REDEEM_INVITE}>{REDEEM.action}</AuthAction>
        <AuthFootnote>
          {REDEEM.footerPrefix}
          {/* `data-nav` is the STRUCTURAL declaration that this control only
              changes which screen you are looking at. It matters because the
              label is "sign in" — a string the honesty sweep in auth.test.tsx
              treats as a promise to authenticate unless the control declares
              otherwise. A link that takes you to the login screen keeps that
              promise exactly; a button that swallowed a password would not,
              and the sweep cannot tell them apart by their text. */}
          <button
            type="button"
            className="auth-link"
            data-nav="frame"
            onClick={() => props.onFrameChange?.('1d')}
          >
            {REDEEM.footerLink}
          </button>
        </AuthFootnote>
      </AuthCard>
    </AuthStage>
  );
}

/**
 * 1j — first-open orientation. Oracle L217–L245.
 *
 * "three points max — empty states teach the rest" (the frame's own
 * annotation). Positions are the oracle's, expressed as percentages of the
 * stage so they track the real workspace instead of an 832×660 specimen: the
 * oracle's absolute lefts/tops (118/52, 150/250, 340/420) are read against
 * that box and become 14%/8%, 18%/38%, 41%/64%.
 *
 * DELIBERATELY NOT ANCHORED to the live rail/panel elements. Anchoring would
 * mean this component reaching into shell/ DOM it does not own, and a
 * coach-mark that mis-anchors points confidently at the wrong thing — worse
 * than one that sits where the canvas puts it. Recorded in the handover as a
 * known limitation, not hidden as a design choice.
 */
export function FrameOrientation(props: FrameProps) {
  const [dismissed, setDismissed] = useState(false);

  const dismiss = useCallback(() => {
    setDismissed(true);
    try {
      window.localStorage.setItem(ORIENTATION_STORAGE_KEY, '1');
    } catch {
      // Private mode / blocked storage. The dismissal still applies to THIS
      // session; it just cannot be remembered. Never let storage take a
      // screen down — the theme store's own rule, and the same reason.
    }
    props.onOrientationDismissed?.();
  }, [props]);

  // The oracle's three positions, as fractions of its 832×660 stage.
  const POS = [
    { left: '14.2%', top: '7.9%', width: 270 },
    { left: '18.0%', top: '37.9%', width: 280 },
    { left: '40.9%', top: '63.6%', width: 300 },
  ];

  return (
    <AuthOverlay backdrop={props.backdrop} testid="auth-orientation">
      {dismissed ? null : (
        <>
          {ORIENTATION.points.map((p, i) => (
            <div
              key={p.n}
              className="auth-coachmark"
              data-testid="auth-coachmark"
              style={{ left: POS[i]!.left, top: POS[i]!.top, width: POS[i]!.width }}
            >
              <div className="auth-coachmark__head">
                <span className="auth-coachmark__n" aria-hidden>
                  {p.n}
                </span>
                <span className="auth-coachmark__title">{p.title}</span>
              </div>
              <div className="auth-coachmark__body">
                {p.body}
                {'emphasis' in p && p.emphasis ? <b>{p.emphasis}</b> : null}
                {'liveWord' in p && p.liveWord ? (
                  <span className="auth-status auth-status--run auth-status--inline">
                    <span className="auth-dot" aria-hidden />
                    {p.liveWord}
                  </span>
                ) : null}
                {'key' in p && p.key ? <kbd className="auth-kbd">{p.key}</kbd> : null}
                {p.bodyTail}
              </div>
              {i === ORIENTATION.points.length - 1 ? (
                <div className="auth-coachmark__foot">
                  <button type="button" className="auth-btn auth-btn--ink auth-btn--sm" onClick={dismiss}>
                    {ORIENTATION.action}
                  </button>
                  <span className="auth-coachmark__note">{ORIENTATION.actionNote}</span>
                </div>
              ) : null}
            </div>
          ))}
        </>
      )}
    </AuthOverlay>
  );
}

/** Has this viewer already dismissed orientation? Hosts gate the frame on it. */
export function isOrientationDismissed(): boolean {
  try {
    return window.localStorage.getItem(ORIENTATION_STORAGE_KEY) === '1';
  } catch {
    // Cannot read ⇒ cannot prove it was dismissed. Showing it again is the
    // recoverable error; suppressing a first-run explanation is not.
    return false;
  }
}

/**
 * 1i — the dead invite. Oracle L247–L264.
 *
 * "Same card for all three — the word changes, never color alone. No space
 * details leak on a dead link." Both halves are load-bearing and both ship:
 * the legend names all three deaths so the reader can tell WHICH one happened
 * without decoding a colour, and the card carries no space membership, no
 * member counts and no server metadata — a dead link is a permission boundary,
 * and the T4 permission-lost rule says nothing leaks across it.
 */
export function FrameInviteDead(_props: FrameProps) {
  return (
    <AuthStage meta={SERVER.joinMeta}>
      <AuthCard width="mid">
        <div className="auth-card__head">
          <span className="auth-alert__glyph auth-alert__glyph--block" aria-hidden>
            ✕
          </span>
          <AuthEyebrow tone="block">{INVITE_DEAD.eyebrow}</AuthEyebrow>
        </div>
        <AuthTitle size="sm">{INVITE_DEAD.title}</AuthTitle>
        <AuthBody size="sm">{INVITE_DEAD.body}</AuthBody>
        <AuthSpecimenNote>
          the revoker and date are the oracle’s specimen values — no operation resolves an invite’s
          state before you join
        </AuthSpecimenNote>
        <AuthRule />
        <div className="auth-legend">
          {INVITE_DEAD.legend.map((row) => (
            <div className="auth-legend__row" key={row.word}>
              <span className={`auth-legend__word auth-legend__word--${row.tone}`}>{row.word}</span>
              <span className="auth-legend__gloss">{row.gloss}</span>
            </div>
          ))}
        </div>
        <AuthFootnote>{INVITE_DEAD.footer}</AuthFootnote>
      </AuthCard>
    </AuthStage>
  );
}
