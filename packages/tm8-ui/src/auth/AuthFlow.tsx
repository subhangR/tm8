/**
 * AuthFlow — the T3 board's ONE entry component.
 *
 * Mountable standalone (the coordinator gates the app on it behind a dev
 * flag), and mountable pinned to a single frame (the review harness, and any
 * host that wants just the account menu or just the expiry dialog).
 *
 * THE FRAME SET IS DATA. Seventeen screens, one registry, one dispatch — the
 * same law `panels/no-branching.test.ts` enforces one lane over: a screen is a
 * row in a table, never a branch in a component. `auth.test.tsx` asserts the
 * registry's order against the oracle's DOM order, so a frame cannot be added,
 * dropped or resequenced without a test saying so.
 *
 * WHAT THIS COMPONENT CANNOT DO, stated where a reader will hit it first: it
 * cannot sign anyone in. The seam behind it exposes `identity()` and no auth
 * command at all (see `reasons.ts`). `onDone` therefore has exactly one caller
 * — an opt-in dev bypass whose own visible copy says no account was created.
 */
import { useCallback, useState, type ComponentType } from 'react';
import { useTheme } from '../theme/useTheme';
import { FrameClaim, FrameFirstSpace, FrameNameServer } from './FirstRunFrames';
import { FrameExpired, FrameLogin, FrameLoginFailed, FrameSignedOut } from './SignInFrames';
import { FrameInviteDead, FrameInviteRedeem, FrameOrientation } from './InviteFrames';
import {
  FrameAddServer,
  FrameConnectFailures,
  FrameGatewayPick,
  FrameServerAdded,
  FrameServerResolved,
} from './ServerFrames';
import { FrameAccessTokens, FrameAccountMenu } from './AccountFrames';
import type { AuthFlowProps, AuthFrameDef, AuthFrameId, FrameProps } from './types';

/**
 * The seventeen frames, in the oracle's DOM order with its own
 * `data-screen-label` strings. The labels are transcribed rather than
 * generated so a diff against the canvas is a string comparison, not a
 * judgement call.
 */
export const AUTH_FRAMES: readonly AuthFrameDef[] = [
  { id: '1a', label: '1a first-run claim', flow: 'first-run', overlay: false },
  { id: '1b', label: '1b first-run name server', flow: 'first-run', overlay: false },
  { id: '1c', label: '1c first-run first space', flow: 'first-run', overlay: false },
  { id: '1d', label: '1d login', flow: 'sign-in', overlay: false },
  { id: '1e', label: '1e login failed', flow: 'sign-in', overlay: false },
  { id: '1f', label: '1f session expired', flow: 'sign-in', overlay: true },
  { id: '1g', label: '1g signed out', flow: 'sign-in', overlay: false },
  { id: '1h', label: '1h invite redeem', flow: 'invite', overlay: false },
  { id: '1j', label: '1j first-open orientation', flow: 'invite', overlay: true },
  { id: '1i', label: '1i invite dead', flow: 'invite', overlay: false },
  { id: '1k', label: '1k add server dialog', flow: 'server', overlay: true },
  { id: '1l', label: '1l server resolved auth', flow: 'server', overlay: true },
  { id: '1o', label: '1o server added rail', flow: 'server', overlay: false },
  { id: '1m', label: '1m gateway pick', flow: 'server', overlay: true },
  { id: '1n', label: '1n connect failures', flow: 'server', overlay: false },
  { id: '1p', label: '1p account menu', flow: 'account', overlay: false },
  { id: '1q', label: '1q access tokens', flow: 'account', overlay: false },
];

const FRAME_COMPONENTS: Record<AuthFrameId, ComponentType<FrameProps>> = {
  '1a': FrameClaim,
  '1b': FrameNameServer,
  '1c': FrameFirstSpace,
  '1d': FrameLogin,
  '1e': FrameLoginFailed,
  '1f': FrameExpired,
  '1g': FrameSignedOut,
  '1h': FrameInviteRedeem,
  '1j': FrameOrientation,
  '1i': FrameInviteDead,
  '1k': FrameAddServer,
  '1l': FrameServerResolved,
  '1o': FrameServerAdded,
  '1m': FrameGatewayPick,
  '1n': FrameConnectFailures,
  '1p': FrameAccountMenu,
  '1q': FrameAccessTokens,
};

/**
 * The one path to `onDone`, and the copy that keeps it honest.
 *
 * A dev flag that silently waved the gate through would recreate the exact
 * defect this whole surface exists to avoid — the viewer could not tell an
 * authenticated app from an unauthenticated one. So the control announces
 * what it is, and the outcome it emits carries the same sentence for any log
 * or banner downstream that wants to repeat it.
 */
export const DEV_BYPASS_NOTE =
  'no account was created and no session was established — this build has no auth executor';

function DevBypass({ onClick }: { onClick: () => void }) {
  return (
    <div className="auth-devbypass" data-testid="auth-dev-bypass">
      <span className="auth-devbypass__label">DEV</span>
      <button type="button" className="auth-btn auth-btn--ghost auth-btn--sm" onClick={onClick}>
        Continue without signing in
      </button>
      <span className="auth-caption">{DEV_BYPASS_NOTE}</span>
    </div>
  );
}

export function AuthFlow(props: AuthFlowProps) {
  const {
    frame,
    initialFrame = '1d',
    onFrameChange,
    onDone,
    rootScope = 'own',
    devBypass = false,
  } = props;

  // Controlled when the host pins a frame; self-driving otherwise. Both are
  // real use cases (the gate pins nothing, the review harness pins one), and
  // conflating them would make the harness unable to step the flow.
  const [ownFrame, setOwnFrame] = useState<AuthFrameId>(initialFrame);
  const current = frame ?? ownFrame;

  const goto = useCallback(
    (id: AuthFrameId) => {
      if (frame === undefined) setOwnFrame(id);
      onFrameChange?.(id);
    },
    [frame, onFrameChange],
  );

  // The theme store is the product's, not a local copy — a flow that themed
  // itself would drift from the app it gates on the first reload.
  const themeControl = useTheme();
  const theme = props.theme ?? themeControl.theme;
  const onThemeChange = props.onThemeChange ?? themeControl.setTheme;

  const Frame = FRAME_COMPONENTS[current];
  const def = AUTH_FRAMES.find((f) => f.id === current)!;

  const body = (
    <div
      className={`auth-root${def.overlay ? ' auth-root--overlay' : ''}`}
      data-frame={current}
      data-testid="auth-frame"
    >
      <Frame
        identity={props.identity}
        liveSessionCount={props.liveSessionCount}
        theme={theme}
        onThemeChange={onThemeChange}
        onFrameChange={goto}
        onOrientationDismissed={props.onOrientationDismissed}
        backdrop={props.backdrop}
      />
      {devBypass ? <DevBypass onClick={() => onDone({ kind: 'dev-bypass', note: DEV_BYPASS_NOTE })} /> : null}
    </div>
  );

  // `inherit` renders bare. D60 puts `zoom: 1.1` on .cv2-root and zoom
  // COMPOUNDS — nesting a second scope inside the gated app would render this
  // flow at 1.21× while every standalone screenshot of it looked correct.
  if (rootScope === 'inherit') return body;

  // `auth-scope` carries height:100% so the stage fills the viewport when this
  // scope is the outermost one. tokens.css gives .cv2-root no height of its
  // own — the shell's own root gets it from shell.css, and a gate mounted
  // above the shell has no such rule to inherit.
  return (
    <div className="cv2-root auth-scope" data-theme={theme}>
      {body}
    </div>
  );
}
