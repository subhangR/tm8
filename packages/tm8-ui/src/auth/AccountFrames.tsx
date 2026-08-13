/**
 * FLOW E · ACCOUNT & TOKENS (T3-3) — 1p account menu · 1q access tokens.
 *
 * 1p IS THE MOST REAL FRAME ON THE BOARD, and it matters that it is: the
 * header renders `identity()` — actual seam data — and the Appearance control
 * is the actual theme store (D1: the account menu is theme's ONE product home,
 * which is why the toggle lives here and nowhere else). Everything else here
 * refuses.
 *
 * 1q is the opposite pole: nothing in the contract catalog can create, list or
 * revoke a token. The surface ships anyway, because remote logins depend on it
 * and a Phase-2 reader needs to see the shape they are building toward.
 */
import {
  AuthAction,
  AuthBody,
  AuthCard,
  AuthEyebrow,
  AuthRefusedRow,
  AuthSpecimenNote,
  AuthStage,
  AuthStatus,
} from './AuthCard';
import { BrandMark } from '../kit';
import { useAuthActions } from './gate-context';
import { ACCOUNT_MENU, SERVER, TOKENS } from './specimen';
import {
  ACT_AS_TEAMMATE,
  COPY_TOKEN,
  EDIT_PROFILE,
  MINT_TOKEN,
  REVOKE_TOKEN,
  SIGN_OUT,
} from './reasons';
import type { FrameProps } from './types';

/** 1p — the account menu. Oracle L399–L427. */
export function FrameAccountMenu(props: FrameProps) {
  const actions = useAuthActions();
  const identity = props.identity;
  const name = identity ? (identity.displayName ?? identity.username) : null;
  const initial = (name ?? '?').trim()[0]?.toUpperCase() ?? '?';

  return (
    <AuthStage testid="auth-account-stage">
      {/* The 42px app header the menu hangs from (oracle L402). Drawn here as
          the menu's ANCHOR only — the real header is the shell's, and this
          frame renders standalone so it needs something to hang from. */}
      <div className="auth-appbar">
        <span className="auth-stage__brand">
          <BrandMark /> tm8
        </span>
        <span className="auth-appbar__rule" aria-hidden />
        <span className="auth-appbar__space">
          <span className="auth-dot auth-dot--brand" aria-hidden />
          atelier
        </span>
        <span className="auth-spacer" />
        <span className="auth-appbar__theme" aria-hidden>
          ◐
        </span>
        <span className="auth-appbar__avatar">{initial}</span>
      </div>

      <div className="auth-menu" data-testid="auth-account-menu">
        <div className="auth-menu__head">
          <span className="auth-avatar auth-avatar--lg" aria-hidden>
            {initial}
          </span>
          {identity ? (
            <div className="auth-server__text">
              <span className="auth-menu__name">{name}</span>
              <span className="auth-menu__handle">
                @{identity.username}
                {identity.isOwner ? ` · owner of ${SERVER.name}` : ` · member of ${SERVER.name}`}
              </span>
            </div>
          ) : (
            // NOT a placeholder name. "Who am I" with no answer is a fact, and
            // rendering a specimen here would be the one lie this frame is in
            // the best position to tell convincingly.
            <div className="auth-server__text">
              <span className="auth-menu__name auth-menu__name--absent">— no identity</span>
              <span className="auth-menu__handle">
                identity has not loaded — seam.identity() has not answered
              </span>
            </div>
          )}
        </div>

        <div className="auth-menu__group">
          <AuthRefusedRow className="auth-menu__row" reason={EDIT_PROFILE} label="Profile">
            <span className="auth-menu__glyph" aria-hidden>
              ◎
            </span>
            {ACCOUNT_MENU.profile}
          </AuthRefusedRow>

          {/* THE ONE FULLY-LIVE ROW. D1: the account menu is theme's only
              product home, so this control is the product, not a dev tool. */}
          <div className="auth-menu__row auth-menu__row--live">
            <span className="auth-menu__glyph" aria-hidden>
              ◐
            </span>
            {ACCOUNT_MENU.appearance}
            <span className="auth-spacer" />
            <span className="auth-toggle" role="group" aria-label="appearance">
              {(['light', 'dark'] as const).map((t) => (
                <button
                  key={t}
                  type="button"
                  className={`auth-toggle__opt${props.theme === t ? ' auth-toggle__opt--on' : ''}`}
                  aria-pressed={props.theme === t}
                  onClick={() => props.onThemeChange?.(t)}
                >
                  {t}
                </button>
              ))}
            </span>
          </div>

          {/* Navigation to 1q is REAL — going to a screen needs no server.
              The oracle's "2" count pill is NOT rendered: no token operation
              exists, so a digit here would be invented rather than read. */}
          <button
            type="button"
            className="auth-menu__row auth-menu__row--live"
            onClick={() => props.onFrameChange?.('1q')}
          >
            <span className="auth-menu__glyph" aria-hidden>
              ⌗
            </span>
            {ACCOUNT_MENU.tokens}
            <span className="auth-spacer" />
            <span className="auth-menu__hollow" title="no token operation exists to count">
              —
            </span>
          </button>

          {/* The one refusal the ORACLE ITSELF draws (L419: greyed row with a
              "phase 2" pill). Oracle and R7 agree exactly here. */}
          <AuthRefusedRow className="auth-menu__row" reason={ACT_AS_TEAMMATE} label="Act as teammate">
            <span className="auth-menu__glyph" aria-hidden>
              ⇄
            </span>
            {ACCOUNT_MENU.actAs}
            <span className="auth-spacer" />
            <span className="auth-menu__pill">{ACCOUNT_MENU.actAsPill}</span>
          </AuthRefusedRow>
        </div>

        <div className="auth-menu__group auth-menu__group--last">
          {actions ? (
            // REAL inside the gate: clears the local session record and drops
            // the viewer back to the flow. The subtitle changes with it — the
            // oracle's "agents keep running" is true of a server sign-out, and
            // this one never touched the server, so it says what it did.
            <button
              type="button"
              className="auth-menu__row auth-menu__row--live auth-menu__row--stacked"
              onClick={actions.signOut}
            >
              <span className="auth-menu__signout">
                <span className="auth-menu__glyph" aria-hidden>
                  ↩
                </span>
                {ACCOUNT_MENU.signOut}
              </span>
              <span className="auth-menu__signout-note">{ACCOUNT_MENU.gateSignOutNote}</span>
            </button>
          ) : (
            <AuthRefusedRow
              className="auth-menu__row auth-menu__row--stacked"
              reason={SIGN_OUT}
              label="Sign out"
            >
              <span className="auth-menu__signout">
                <span className="auth-menu__glyph" aria-hidden>
                  ↩
                </span>
                {ACCOUNT_MENU.signOut}
              </span>
              {/* The honest scope line, verbatim (oracle L422). It is the whole
                  reason this verb has a subtitle at all. */}
              <span className="auth-menu__signout-note">{ACCOUNT_MENU.signOutNote}</span>
            </AuthRefusedRow>
          )}
        </div>
      </div>
    </AuthStage>
  );
}

/**
 * 1q — access tokens. Oracle L429–L454.
 *
 * "one-time reveal · hash-only storage · revoke = live kill". The one-time
 * reveal card ships because it is the frame's whole idea — a secret you can
 * see exactly once — and it carries a specimen note, because a string that
 * LOOKS like a credential is the single most dangerous specimen on this board.
 */
export function FrameAccessTokens(_props: FrameProps) {
  return (
    <AuthStage>
      <AuthCard width="wide">
        <div className="auth-card__head">
          <AuthEyebrow>{TOKENS.eyebrow}</AuthEyebrow>
          <span className="auth-spacer" />
          <AuthAction size="sm" reason={MINT_TOKEN}>
            {TOKENS.action}
          </AuthAction>
        </div>
        <AuthBody size="sm">{TOKENS.body}</AuthBody>

        {/* The one-time reveal (oracle L435): brass-tinted card, NEW pill, the
            secret in mono, and the "shown once" warning in brass-2. */}
        <div className="auth-reveal">
          <div className="auth-reveal__head">
            <span className="auth-reveal__name">{TOKENS.fresh.name}</span>
            <span className="auth-reveal__pill">{TOKENS.fresh.pill}</span>
          </div>
          <div className="auth-reveal__secret">
            <span className="auth-reveal__value">{TOKENS.fresh.secret}</span>
            <span className="auth-spacer" />
            <AuthRefusedRow reason={COPY_TOKEN} label="copy token">
              <span className="auth-reveal__copy">{TOKENS.fresh.copy}</span>
            </AuthRefusedRow>
          </div>
          <div className="auth-reveal__once">
            <b>{TOKENS.fresh.onceLead}</b>
            {TOKENS.fresh.onceBody}
          </div>
        </div>
        <AuthSpecimenNote>
          this is NOT a credential — it is the oracle’s specimen string. No token operation exists in
          the contract catalog, so nothing here was minted and nothing can be presented
        </AuthSpecimenNote>

        <div className="auth-tokens">
          {TOKENS.rows.map((row) => (
            <div className="auth-tokens__row" key={row.name}>
              <div className="auth-server__text">
                <span
                  className={`auth-tokens__name${row.revoked ? ' auth-tokens__name--revoked' : ''}`}
                >
                  {row.name}
                </span>
                <span className="auth-tokens__meta">{row.meta}</span>
              </div>
              <span className="auth-spacer" />
              {row.revoked ? (
                // A revoked token has no verb left — the WORD is the whole
                // row's state, so there is nothing here to refuse.
                <span className="auth-tokens__revoked">{row.status}</span>
              ) : (
                <>
                  <AuthStatus tone={row.tone}>{row.status}</AuthStatus>
                  <AuthRefusedRow reason={REVOKE_TOKEN} label={`revoke ${row.name}`}>
                    <span className="auth-tokens__revoke">revoke</span>
                  </AuthRefusedRow>
                </>
              )}
            </div>
          ))}
        </div>
      </AuthCard>
    </AuthStage>
  );
}
