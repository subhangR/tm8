/**
 * FLOW D · ADD REMOTE SERVER (PHASE 2) — 1k endpoint · 1l resolved+auth ·
 * 1o added · 1m gateway · 1n failures. Oracle DOM order, which puts the
 * success result (1o) between the auth step and the gateway branch.
 *
 * THIS WHOLE FLOW IS ALREADY LEDGERED AS REFUSED. D13 rules the rail's
 * `＋ add server` affordance permanently disabled-with-reason ("remote servers
 * arrive in Phase 2"); these are the frames BEHIND that affordance. Building
 * them reachable-but-refusing is the consistent reading of D13: L6 says
 * unavailable ≠ invisible, and hiding the destination of a visible-but-refused
 * control would make Phase 2 a surprise rather than a promise kept.
 */
import {
  AuthAction,
  AuthAlert,
  AuthBody,
  AuthCard,
  AuthEyebrow,
  AuthField,
  AuthRefusedRow,
  AuthServerTile,
  AuthSpecimenNote,
  AuthStage,
  AuthStatus,
  AuthTitle,
} from './AuthCard';
import { AuthOverlay } from './SignInFrames';
import { ADD_SERVER, CONNECT_FAILURES, GATEWAY, RESOLVED, SERVER, SERVER_ADDED } from './specimen';
import {
  ADD_RESOLVED_SERVER,
  CONNECT_ENDPOINT,
  CONNECT_USE_PASSWORD,
  GATEWAY_CONTINUE,
  RETRY_CONNECT,
  SERVER_GROUPED_RAIL,
  UPDATE_INSTRUCTIONS,
} from './reasons';
import type { FrameProps } from './types';

/** 1k — the endpoint dialog. Oracle L276–L296. */
export function FrameAddServer(props: FrameProps) {
  return (
    <AuthOverlay backdrop={props.backdrop}>
      <AuthCard width="modal">
        <AuthTitle size="sm">
          <span className="auth-dialog__title">{ADD_SERVER.title}</span>
        </AuthTitle>
        <AuthBody size="sm">{ADD_SERVER.body}</AuthBody>
        <AuthField
          label="ENDPOINT URL"
          value={ADD_SERVER.endpoint}
          mono
          state="focus"
          hint={ADD_SERVER.endpointHint}
        />
        <AuthField label="NICKNAME · OPTIONAL" placeholder={ADD_SERVER.nicknamePlaceholder} />
        <div className="auth-dialog__foot">
          {/* Cancel is REAL: closing a dialog needs no server. */}
          <AuthAction variant="ghost" size="sm" onClick={() => props.onFrameChange?.('1p')}>
            {ADD_SERVER.cancel}
          </AuthAction>
          <AuthAction size="sm" reason={CONNECT_ENDPOINT}>
            {ADD_SERVER.action}
          </AuthAction>
        </div>
      </AuthCard>
    </AuthOverlay>
  );
}

/**
 * 1l — resolved, now authenticate. Oracle L301–L323.
 *
 * "server identifies itself before asking for credentials" — the frame's own
 * annotation and the reason it exists as a separate step. The identity card at
 * the top is entirely specimen: no handshake operation produced it.
 */
export function FrameServerResolved(props: FrameProps) {
  return (
    <AuthOverlay backdrop={props.backdrop}>
      <AuthCard width="modal">
        <AuthTitle size="sm">
          <span className="auth-dialog__title">{RESOLVED.title}</span>
        </AuthTitle>

        <div className="auth-inset">
          <AuthServerTile
            glyph={SERVER.glyph}
            name={SERVER.name}
            meta={SERVER.resolvedMeta}
            trailing={<AuthStatus tone="run">{RESOLVED.reachable}</AuthStatus>}
          />
        </div>
        <AuthSpecimenNote>
          the version, protocol and reachability are the oracle’s specimen values — no endpoint
          handshake operation exists
        </AuthSpecimenNote>

        <AuthBody size="sm">{RESOLVED.body}</AuthBody>

        {/* Segmented token|password picker (oracle L314). Both halves refuse
            at the submit, so the picker itself stays live — switching between
            two refusals is honest, and hiding one would hide a gap. */}
        <div className="auth-segmented" role="tablist" aria-label="credential type">
          {RESOLVED.tabs.map((tab, i) => (
            <span
              key={tab}
              role="tab"
              aria-selected={i === 0}
              className={`auth-segmented__tab${i === 0 ? ' auth-segmented__tab--on' : ''}`}
            >
              {tab}
            </span>
          ))}
        </div>

        <AuthField label="TOKEN" value={RESOLVED.token} mono state="focus" hint={RESOLVED.tokenHint} />

        <div className="auth-dialog__foot">
          <AuthAction variant="ghost" size="sm" onClick={() => props.onFrameChange?.('1k')}>
            {RESOLVED.back}
          </AuthAction>
          <AuthAction size="sm" reason={ADD_RESOLVED_SERVER}>
            {RESOLVED.action}
          </AuthAction>
        </div>
      </AuthCard>
    </AuthOverlay>
  );
}

/**
 * 1o — the rail result. Oracle L328–L345.
 *
 * WHAT THIS FRAME DOES NOT BUILD, and why. The oracle draws a rail with server
 * GROUPS — "servers are groups in the one rail (RULING I) — never a second
 * rail". That rail is `src/shell/MenuRail.tsx`, another seat's file, and its
 * Phase-2 server grouping is that seat's work. A static replica here would be
 * duplication that rots the first time the real rail changes, and the lane
 * boundary is not mine to cross. So this frame builds its OWN contribution —
 * the success toast — and states the rest rather than faking it.
 */
export function FrameServerAdded(_props: FrameProps) {
  return (
    <AuthStage meta={SERVER.hostMeta} testid="auth-server-added">
      <AuthCard width="mid">
        <AuthEyebrow>SERVER ADDED · THE RAIL RESULT</AuthEyebrow>
        <AuthRefusedRow reason={SERVER_GROUPED_RAIL} label="server-grouped rail">
          <span className="auth-placeholder">
            ▤ the rail, with forge as a group above its two spaces
          </span>
        </AuthRefusedRow>

        {/* The toast IS this frame's own artifact, and it ships. Ink surface
            over paper text, so it opens a nested dark scope (D24) rather than
            restating the dark ramp — the ✓ resolves to dark --pn-run and the
            text to dark --pn-ink, which is exactly what the oracle draws. */}
        <div className="auth-toast" data-theme="dark" data-testid="auth-toast">
          <span className="auth-toast__glyph" aria-hidden>
            ✓
          </span>
          <span className="auth-toast__text">
            <b>{SERVER_ADDED.lead}</b>
            {SERVER_ADDED.body}
          </span>
        </div>
        <AuthSpecimenNote>
          the handle and space count in the toast are the oracle’s specimen values — Phase 2 (D13)
        </AuthSpecimenNote>
      </AuthCard>
    </AuthStage>
  );
}

/**
 * 1m — the gateway branch. Oracle L348–L365.
 *
 * RULING I, preserved: the rail lists resolved Servers, never the gateway.
 * Each hosted server carries its own joinability WORD — member / invite
 * required / maintenance — so the three states are legible without colour.
 */
export function FrameGatewayPick(props: FrameProps) {
  return (
    <AuthOverlay backdrop={props.backdrop}>
      <AuthCard width="mid">
        <AuthTitle size="sm">
          <span className="auth-dialog__title">{GATEWAY.title}</span>
        </AuthTitle>
        <AuthBody size="sm">
          <span className="auth-mono">{GATEWAY.host}</span>
          {GATEWAY.bodyTail}
        </AuthBody>

        <div className="auth-stack auth-stack--tight">
          {GATEWAY.servers.map((s) => (
            <div
              key={s.name}
              className={`auth-pick auth-pick--${s.state}${s.state === 'joinable' ? ' auth-pick--on' : ''}`}
            >
              <span
                className={`auth-glyph auth-glyph--sm auth-glyph--${
                  s.state === 'joinable' ? 'brand' : s.state === 'invite' ? 'info' : 'muted'
                }`}
                aria-hidden
              >
                {s.glyph}
              </span>
              <div className="auth-server__text">
                <span className="auth-pick__name">{s.name}</span>
                <span className={`auth-pick__meta${s.state === 'down' ? ' auth-pick__meta--wait' : ''}`}>
                  {s.meta}
                </span>
              </div>
              <span className="auth-spacer" />
              {s.state === 'joinable' ? (
                <span className="auth-pick__check" aria-label="selected">
                  ✓
                </span>
              ) : null}
            </div>
          ))}
        </div>
        <AuthSpecimenNote>
          the gateway’s three servers are the oracle’s specimen values — no operation enumerates a
          gateway
        </AuthSpecimenNote>

        <div className="auth-dialog__foot">
          <AuthAction variant="ghost" size="sm" onClick={() => props.onFrameChange?.('1k')}>
            {GATEWAY.back}
          </AuthAction>
          <AuthAction size="sm" reason={GATEWAY_CONTINUE}>
            {GATEWAY.action}
          </AuthAction>
        </div>
      </AuthCard>
    </AuthOverlay>
  );
}

/**
 * 1n — the three ways it fails. Oracle L367–L388.
 *
 * "T1-4 honesty family: reason · evidence · next step". The evidence line is
 * the part that makes these cards worth building even with no connect
 * operation behind them — it is the shape a real failure must be reported in,
 * and having the shape built is what stops the first real failure being
 * reported as a toast saying "something went wrong".
 */
export function FrameConnectFailures(props: FrameProps) {
  const REASONS = [RETRY_CONNECT, CONNECT_USE_PASSWORD, UPDATE_INSTRUCTIONS];

  return (
    <AuthStage meta={SERVER.hostMeta}>
      <div className="auth-stack auth-stack--cards">
        {CONNECT_FAILURES.map((f, i) => (
          <div className="auth-failcard" key={f.eyebrow}>
            <div className="auth-card__head">
              {f.tone === 'block' ? (
                <span className="auth-alert__glyph auth-alert__glyph--block" aria-hidden>
                  ✕
                </span>
              ) : (
                <span className="auth-dot auth-dot--wait" aria-hidden />
              )}
              <AuthEyebrow tone={f.tone}>{f.eyebrow}</AuthEyebrow>
            </div>
            <AuthBody size="sm">{f.body}</AuthBody>
            {f.evidence ? <div className="auth-evidence">{f.evidence}</div> : null}
            <div className="auth-failcard__foot">
              <AuthAction size="sm" reason={REASONS[i]!}>
                {f.primary}
              </AuthAction>
              {/* The SECOND action of each card is the one that can be real:
                  "Edit URL" and "Dismiss" are client nav and client state.
                  "Use password" is not — it needs a credential exchange. */}
              {f.secondary === 'Edit URL' ? (
                <AuthAction variant="ghost" size="sm" onClick={() => props.onFrameChange?.('1k')}>
                  {f.secondary}
                </AuthAction>
              ) : f.secondary === 'Dismiss' ? (
                <AuthAction variant="ghost" size="sm" onClick={() => props.onFrameChange?.('1k')}>
                  {f.secondary}
                </AuthAction>
              ) : (
                <AuthAction variant="ghost" size="sm" reason={CONNECT_USE_PASSWORD}>
                  {f.secondary}
                </AuthAction>
              )}
            </div>
          </div>
        ))}
        <AuthAlert tone="wait" glyph="◐">
          These three cards are the failure SHAPES, drawn from the oracle. No connect operation
          exists to have produced any of them — Phase 2 (D13).
        </AuthAlert>
      </div>
    </AuthStage>
  );
}
