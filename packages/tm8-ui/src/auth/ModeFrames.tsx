/**
 * FLOW A · FIRST RUN, after the claim — 1s choose a node mode · 1r restart
 * needed (doc 20 §5.3, as adjusted by decision 34).
 *
 * WHY THE CHOOSER COMES AFTER THE CLAIM. Doc 20 drew it as a signed-out card on
 * an unclaimed node, with Personal skipping the password. Decision 34 (the
 * program lead's default C, 2026-09-26) closed that door: a local agent is never
 * the owner, so every node is claimed once with a password, and the launch
 * cookie (`tm8 open`) replaces typing it afterwards. So the gate shows 1s to the
 * OWNER, signed in, on a claimed node with no recorded mode — and the server
 * refuses `node.mode.set` on an unclaimed node regardless of what this renders.
 *
 * Outside the gate (the review board) both frames refuse, like every other.
 */
import type { NodeModeView } from '@tm8/contract';
import { AuthAction, AuthBody, AuthCaption, AuthCard, AuthEyebrow, AuthFailureBanner, AuthStage, AuthTitle } from './AuthCard';
import { useAuthActions } from './gate-context';
import { failureCopy } from './failures';
import { activeNodeLabel } from '../servers/server-key';
import { MODE, SERVER } from './specimen';
import { CHOOSE_NODE_MODE, DISMISS_RESTART_NOTICE } from './reasons';
import type { FrameProps } from './types';

const CHOICES: readonly NodeModeView[] = ['personal', 'peer', 'server'];

/** 1s — choose Personal, Peer or Server. */
export function FrameChooseMode(_props: FrameProps) {
  const actions = useAuthActions();
  const failure = actions?.failure;
  const pinned = actions?.nodeClaim?.modeSource === 'env';

  return (
    <AuthStage meta={actions ? activeNodeLabel() : SERVER.unclaimedMeta} testid="mode-chooser">
      <AuthCard>
        <div className="auth-card__head">
          <AuthEyebrow>{MODE.eyebrow}</AuthEyebrow>
        </div>
        <AuthTitle>{MODE.title}</AuthTitle>
        <AuthBody>{MODE.body}</AuthBody>

        {failure ? (
          <AuthFailureBanner>
            <b className="auth-alert__lead">{failureCopy(failure).lead}</b>
            {failureCopy(failure).body}
          </AuthFailureBanner>
        ) : null}

        {pinned ? <AuthCaption>{MODE.pinned}</AuthCaption> : null}

        {CHOICES.map((mode) => (
          <div key={mode} className="auth-mode-choice" data-mode={mode}>
            {actions && !pinned ? (
              <AuthAction variant={mode === 'personal' ? 'ink' : 'ghost'} onClick={() => void actions.chooseMode(mode)}>
                {MODE[mode].action}
              </AuthAction>
            ) : (
              <AuthAction variant={mode === 'personal' ? 'ink' : 'ghost'} reason={CHOOSE_NODE_MODE}>
                {MODE[mode].action}
              </AuthAction>
            )}
            <AuthCaption>{MODE[mode].line}</AuthCaption>
          </div>
        ))}
      </AuthCard>
    </AuthStage>
  );
}

/**
 * 1r — the mode is recorded but the running server has not moved. The browser
 * cannot know how this node was started (systemd, a terminal, the desktop app),
 * so it says "restart the tm8 server" and nothing more specific.
 */
export function FrameRestartRequired(_props: FrameProps) {
  const actions = useAuthActions();
  return (
    <AuthStage meta={actions ? activeNodeLabel() : SERVER.unclaimedMeta} testid="mode-restart">
      <AuthCard>
        <div className="auth-card__head">
          <AuthEyebrow tone="wait">{MODE.restartEyebrow}</AuthEyebrow>
        </div>
        <AuthTitle>{MODE.restartTitle}</AuthTitle>
        <AuthBody>{MODE.restartBody}</AuthBody>
        {actions ? (
          <AuthAction onClick={actions.dismissModeNotice}>{MODE.restartAction}</AuthAction>
        ) : (
          <AuthAction reason={DISMISS_RESTART_NOTICE}>{MODE.restartAction}</AuthAction>
        )}
      </AuthCard>
    </AuthStage>
  );
}
