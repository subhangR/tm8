/**
 * FLOW B · SIGN IN & SESSION (T3-1) — 1d login · 1e failed · 1f expired ·
 * 1g signed out.
 *
 * "The returning-member login and every session edge" (oracle L96). Inside
 * the gate 1d is REAL: submit performs auth.login against the active server
 * and stores the tm8s_ pass. Outside it (the review board) the identical
 * form refuses out loud — a login form that pretends to authenticate is the
 * worst lie this app could tell, and the executor-through-context split is
 * what makes the lie unbuildable.
 */
import { useState, type ReactNode } from 'react';
import { useReasonDisclosure } from '../panels/honesty/useReasonDisclosure';
import {
  AuthAction,
  AuthAlert,
  AuthBody,
  AuthCaption,
  AuthCard,
  AuthEyebrow,
  AuthFailureBanner,
  AuthField,
  AuthFootnote,
  AuthRule,
  AuthServerTile,
  AuthSpecimenNote,
  AuthStage,
  AuthTitle,
} from './AuthCard';
import { useAuthActions } from './gate-context';
import { canUseLoopbackAutoOwner, readActiveServerId } from '../servers/server-key';
import { failureCopy, signInFailureLead } from './failures';
import { EXPIRED, LOGIN, LOGIN_FAILED, SERVER, SIGNED_OUT } from './specimen';
import {
  REAUTH,
  SIGN_BACK_IN,
  SIGN_IN_PASSWORD,
  SIGN_IN_RETRY,
  SIGN_IN_TOKEN,
  SWITCH_ACCOUNT,
} from './reasons';
import type { FrameProps } from './types';

/**
 * 1d — Login. Oracle L100–L126.
 *
 * The oracle exposes password-vs-token as a canvas TWEAK (`authPrimary`, the
 * `<sc-if>` pair at L107/L115) with the note "primary switches in Tweaks".
 * A tweak is the canvas's way of drawing two states of one frame; the product
 * form of "two states of one frame" is a control, and the oracle draws that
 * control too — the "use an access token instead" link at L112 and its
 * mirror at L119. So both halves ship and the link is the switch.
 */
export function FrameLogin(_props: FrameProps) {
  const [mode, setMode] = useState<'password' | 'token'>('password');
  const actions = useAuthActions();
  const [handle, setHandle] = useState(() => actions?.account?.handle ?? '');
  const [password, setPassword] = useState('');
  const [show, setShow] = useState(false);
  const failure = actions?.failure;

  const submit = () => void actions?.signIn(handle, password);

  // The tile must name the server actually being signed into, not the
  // oracle's specimen — the pass this mints is per server, and a viewer
  // pointed at a named connection is authenticating THERE.
  const serverId = actions ? readActiveServerId() : null;
  const mayCreateAccount = Boolean(actions && serverId && canUseLoopbackAutoOwner(
    serverId,
    globalThis.location?.hostname ?? '',
  ));

  return (
    <AuthStage meta={actions ? SERVER.localMeta : SERVER.secureMeta}>
      <AuthCard>
        <AuthServerTile
          glyph={serverId ? serverId[0]!.toUpperCase() : SERVER.glyph}
          name={serverId ?? SERVER.name}
          meta={actions ? SERVER.localEndpoint : SERVER.endpoint}
        />
        <AuthTitle>{LOGIN.title}</AuthTitle>

        {failure && mode === 'password' ? (
          <AuthFailureBanner>
            <b className="auth-alert__lead">{failureCopy(failure).lead}</b>
            {failure.kind === 'bad-credentials' ? (
              <>
                {' — this server refused '}
                {signInFailureLead(handle)}
                {' with that password.'}
              </>
            ) : (
              failureCopy(failure).body
            )}
          </AuthFailureBanner>
        ) : null}

        {mode === 'password' ? (
          <div className="auth-stack">
            {actions ? (
              <>
                <AuthField label="HANDLE" value={handle} onChange={setHandle} />
                <AuthField
                  label="PASSWORD"
                  type={show ? 'text' : 'password'}
                  value={password}
                  onChange={setPassword}
                  state={failure?.kind === 'bad-credentials' ? 'error' : 'idle'}
                  trailing={
                    <button
                      type="button"
                      className="auth-field__show"
                      data-nav="reveal"
                      onClick={() => setShow((v) => !v)}
                    >
                      {show ? 'hide' : 'show'}
                    </button>
                  }
                />
                <AuthAction onClick={submit}>
                  {actions.busy ? LOGIN.busyAction : LOGIN.passwordAction}
                </AuthAction>
              </>
            ) : (
              <>
                <AuthField label="HANDLE" value={LOGIN.handle} />
                <AuthField
                  label="PASSWORD"
                  type="password"
                  value={LOGIN.password}
                  trailing={<span className="auth-field__show">show</span>}
                />
                <AuthAction reason={SIGN_IN_PASSWORD}>{LOGIN.passwordAction}</AuthAction>
              </>
            )}
            <div className="auth-switch">
              <button
                type="button"
                className="auth-link"
                data-nav="mode"
                onClick={() => setMode('token')}
              >
                {LOGIN.toToken}
              </button>
              {/* THE SECOND PATH, user-ordered, is truthful only where an
                  unauthenticated signup can actually run: the local loopback
                  auto-owner path. Remote and relayed nodes require operator
                  provisioning, so advertising this there leads to a refusal
                  the viewer cannot resolve. */}
              {mayCreateAccount ? (
                <>
                  <span className="auth-switch__sep" aria-hidden>
                    ·
                  </span>
                  <button
                    type="button"
                    className="auth-link"
                    data-nav="frame"
                    onClick={() => _props.onFrameChange?.('1a')}
                  >
                    {LOGIN.toCreateAnother}
                  </button>
                </>
              ) : null}
            </div>
          </div>
        ) : (
          <div className="auth-stack">
            <AuthField label="ACCESS TOKEN" value={LOGIN.token} mono hint={LOGIN.tokenHint} />
            <AuthAction reason={SIGN_IN_TOKEN}>{LOGIN.tokenAction}</AuthAction>
            <div className="auth-switch">
              <button
                type="button"
                className="auth-link"
                data-nav="mode"
                onClick={() => setMode('password')}
              >
                {LOGIN.toPassword}
              </button>
            </div>
          </div>
        )}

        <AuthRule />
        {/* Board keeps the oracle footer; the live gate must not: "forge" is a
            specimen server name and "flow C" is reviewer vocabulary, and both
            were being shown to real signed-out viewers. `gateFooter` says what
            is true of THIS node instead. */}
        <AuthFootnote>{actions ? LOGIN.gateFooter : LOGIN.footer}</AuthFootnote>
      </AuthCard>
    </AuthStage>
  );
}

/**
 * 1e — Sign-in failed. Oracle L131–L145.
 *
 * The T1-4 honesty voice at its sharpest: "exact reason + consequence, color
 * never alone". The attempt numbers ARE the consequence — and no server
 * computed them, so they carry a specimen note. The failed field keeps its
 * block-toned label AND its block-toned ring: two signals, per the law.
 */
export function FrameLoginFailed(_props: FrameProps) {
  return (
    <AuthStage meta={SERVER.secureMeta}>
      <AuthCard>
        <AuthServerTile glyph={SERVER.glyph} name={SERVER.name} meta={SERVER.endpoint} />
        <AuthTitle>{LOGIN.title}</AuthTitle>

        <AuthAlert tone="block" glyph="✕" lead={LOGIN_FAILED.banner}>
          {LOGIN_FAILED.bannerBody}
        </AuthAlert>
        <AuthSpecimenNote>
          the attempt count and hold window are the oracle’s specimen values — no sign-in operation
          exists to have produced them
        </AuthSpecimenNote>

        <AuthField label="HANDLE" value={LOGIN.handle} />
        <AuthField
          label={LOGIN_FAILED.fieldLabel}
          type="password"
          value={LOGIN_FAILED.password}
          state="error"
        />
        <AuthAction reason={SIGN_IN_RETRY}>{LOGIN_FAILED.action}</AuthAction>
        <AuthFootnote>{LOGIN_FAILED.footer}</AuthFootnote>
      </AuthCard>
    </AuthStage>
  );
}

/**
 * 1f — Session expired, re-auth in place. Oracle L148–L170.
 *
 * The dimmed workspace behind the modal is the HOST's, not ours: this frame
 * renders scrim + card and nothing else, so in the gated app the viewer's real
 * work sits underneath — which is the entire point of the frame ("the URL
 * keeps panels and pins"). The review harness supplies its own backdrop.
 */
export function FrameExpired(props: FrameProps) {
  return (
    <AuthOverlay backdrop={props.backdrop}>
      <AuthCard width="modal">
        <div className="auth-card__head">
          <span className="auth-dot auth-dot--wait" aria-hidden />
          <AuthEyebrow tone="wait">{EXPIRED.eyebrow}</AuthEyebrow>
        </div>
        <AuthTitle size="sm">{EXPIRED.title}</AuthTitle>
        <AuthBody size="sm">{EXPIRED.body}</AuthBody>
        <AuthField label="PASSWORD" type="password" state="focus" />
        <AuthAction reason={REAUTH}>{EXPIRED.action}</AuthAction>
        <div className="auth-footnote auth-footnote--md">
          {EXPIRED.switchPrefix}
          <AuthInlineRefusal reason={SWITCH_ACCOUNT}>{EXPIRED.switchLink}</AuthInlineRefusal>
          {EXPIRED.switchSuffix}
        </div>
      </AuthCard>
    </AuthOverlay>
  );
}

/**
 * 1g — Signed out. Oracle L173–L186.
 *
 * "signing out stops nothing" is the honest half of the frame and it ships
 * verbatim. The live-session count is the dishonest half if invented: while
 * signed out, `seam.liveness` is space-scoped and unreachable, so the sentence
 * renders ONLY when a host can supply a real number.
 */
export function FrameSignedOut(props: FrameProps) {
  const actions = useAuthActions();
  return (
    <AuthStage meta={SERVER.hostMeta}>
      <AuthCard width="narrow" className="auth-card--centred">
        <span className="auth-glyph auth-glyph--md auth-glyph--brand" aria-hidden>
          {SERVER.glyph}
        </span>
        <AuthTitle size="sm">{SIGNED_OUT.title}</AuthTitle>
        <AuthBody size="sm">{actions ? SIGNED_OUT.gateBody : SIGNED_OUT.body}</AuthBody>
        {actions ? <AuthCaption>{SIGNED_OUT.gateNote}</AuthCaption> : null}
        {/* Inside the gate this is real: it returns to the sign-in frame,
            whose submit performs auth.login. Outside it there is no executor
            and it refuses, same component. */}
        {actions ? (
          <AuthAction onClick={() => props.onFrameChange?.('1d')}>{SIGNED_OUT.action}</AuthAction>
        ) : (
          <AuthAction reason={SIGN_BACK_IN}>{SIGNED_OUT.action}</AuthAction>
        )}
        {typeof props.liveSessionCount === 'number' ? (
          <div className="auth-footnote" data-testid="auth-live-count">
            {props.liveSessionCount} live session{props.liveSessionCount === 1 ? '' : 's'}{' '}
            {SIGNED_OUT.liveSuffix}
          </div>
        ) : null}
      </AuthCard>
    </AuthStage>
  );
}

/* ── shared overlay furniture ──────────────────────────────────────────── */

/**
 * Scrim + centred dialog. `rgba(35,32,27,.38)` (oracle L159) is --pn-ink at
 * 38%; auth.css derives it with `color-mix(… 38%, transparent)`, which is
 * exactly that alpha and re-themes for free.
 */
export function AuthOverlay({
  backdrop,
  children,
  testid,
}: {
  backdrop?: ReactNode;
  children: ReactNode;
  testid?: string;
}) {
  return (
    <div className="auth-overlay" data-testid={testid}>
      {backdrop ? <div className="auth-overlay__behind">{backdrop}</div> : null}
      <div className="auth-scrim">{children}</div>
    </div>
  );
}

/**
 * A refused control that must sit INSIDE a sentence (1f's "sign in as someone
 * else"). Same D28 mechanics; the reason rides on the tooltip form because a
 * caption would break the line it lives in.
 */
export function AuthInlineRefusal({
  reason,
  children,
}: {
  reason: { cause: string; remedy?: string };
  children: ReactNode;
}) {
  const id = `auth-inline-${reason.cause.replace(/\W+/g, '-').toLowerCase()}`;
  /* Tap opens the reason. `.auth-tip` was revealed by `:hover`/`:focus-within`
     only, so on a phone this refusal was silent — and this one sits on the SIGN-IN
     screen, where a user who cannot read the reason cannot get into the product
     at all. See panels/honesty/useReasonDisclosure. */
  const tip = useReasonDisclosure();
  return (
    <span className="auth-inline-refusal" {...tip.hostProps}>
      <span
        className="auth-link auth-link--refused"
        role="button"
        aria-disabled="true"
        aria-describedby={id}
        tabIndex={0}
        data-testid="disabled-with-reason"
        {...tip.triggerProps}
      >
        {children}
      </span>
      <span className="auth-tip" id={id} role="tooltip">
        <span className="auth-tip__cause">{reason.cause}</span>
        {reason.remedy ? <span className="auth-tip__remedy">{reason.remedy}</span> : null}
      </span>
    </span>
  );
}
