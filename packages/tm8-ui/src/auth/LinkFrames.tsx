/**
 * LIVE-GATE FRAMES WITH NO ORACLE DRAWING — the two ways a link alone gets a
 * person in, beside the claim (1a) and invite (1h) frames:
 *
 *   1r · setup link   — a node admin created (or reset) the account and sent a
 *                       one-time `#setup=tm8a_…` link (324). Choose a password,
 *                       and you are signed in (`auth.setup.redeem`).
 *   1s · invite signup — a space invite opened by someone with no account.
 *                       Create one with the invite (`auth.invite.signup`, 141)
 *                       and you are signed in, already a member.
 *
 * They are not on the review board (`AUTH_FRAMES` is the oracle's seventeen),
 * so they are listed in `LIVE_AUTH_FRAMES`. Outside a gate there is no
 * executor, and they say so instead of drawing a button.
 */
import { useEffect, useState } from 'react';
import type { AuthSetupResolveResult } from '@tm8/contract';
import {
  AuthAction,
  AuthBody,
  AuthCard,
  AuthEyebrow,
  AuthFailureBanner,
  AuthField,
  AuthFootnote,
  AuthStage,
  AuthTitle,
} from './AuthCard';
import { useAuthActions } from './gate-context';
import { activeNodeLabel } from '../servers/server-key';
import { failureCopy } from './failures';
import { handleFrom, MIN_PASSWORD_LENGTH, resolveSetupLink } from './session';
import type { FrameProps } from './types';

/**
 * The `#setup=` token, read once and scrubbed from the address bar — the claim
 * link's rule (FirstRunFrames `readClaimTokenFromUrl`): a fragment never
 * reaches a server log, and once it is in memory it should not linger in
 * history or a screenshot either.
 */
export function readSetupTokenFromUrl(): string | null {
  try {
    const hash = globalThis.location?.hash ?? '';
    const token = new URLSearchParams(hash.replace(/^#/, '')).get('setup')?.trim() ?? '';
    if (!token) return null;
    if (globalThis.history?.replaceState) {
      const { pathname, search } = globalThis.location;
      globalThis.history.replaceState(null, '', `${pathname}${search}`);
    }
    return token;
  } catch {
    return null;
  }
}

function SignInSwitch({ onFrameChange, label }: Pick<FrameProps, 'onFrameChange'> & { label: string }) {
  return (
    <div className="auth-switch">
      <button type="button" className="auth-link" data-nav="frame" onClick={() => onFrameChange?.('1d')}>
        {label}
      </button>
    </div>
  );
}

function Failure() {
  const failure = useAuthActions()?.failure;
  if (!failure) return null;
  const copy = failureCopy(failure);
  return (
    <AuthFailureBanner>
      <b className="auth-alert__lead">{copy.lead}</b>
      {copy.body}
    </AuthFailureBanner>
  );
}

function PasswordField({ value, onChange, hint }: { value: string; onChange: (v: string) => void; hint: string }) {
  const [show, setShow] = useState(false);
  return (
    <AuthField
      label="PASSWORD"
      type={show ? 'text' : 'password'}
      value={value}
      onChange={onChange}
      hint={hint}
      trailing={
        <button type="button" className="auth-field__show" data-nav="reveal" onClick={() => setShow((v) => !v)}>
          {show ? 'hide' : 'show'}
        </button>
      }
    />
  );
}

/** 1r — choose your password with a node admin's one-time setup link. */
export function FrameSetupLink(props: FrameProps) {
  const actions = useAuthActions();
  const token = actions?.setupToken ?? '';
  const [password, setPassword] = useState('');
  const [preview, setPreview] = useState<AuthSetupResolveResult | null>(null);

  useEffect(() => {
    if (!token) return;
    let live = true;
    void resolveSetupLink(token).then(
      (result) => live && setPreview(result),
      () => live && setPreview(null),
    );
    return () => {
      live = false;
    };
  }, [token]);

  const dead = preview?.status === 'invalid' || (actions !== null && !token);
  const who = preview?.status === 'valid' ? preview : null;
  return (
    <AuthStage meta={activeNodeLabel()}>
      <AuthCard>
        <AuthEyebrow>{who?.purpose === 'reset' ? 'PASSWORD RESET' : 'ACCOUNT SETUP'}</AuthEyebrow>
        <AuthTitle>
          {dead ? 'This setup link no longer works' : who ? `Choose a password for @${who.username}` : 'Choose your password'}
        </AuthTitle>
        <AuthBody>
          {dead
            ? 'It was already used, it expired, a newer link replaced it, or the account was disabled. Ask a node admin for a new one.'
            : 'A node admin set this account up and sent you this link. It works once. Choose a password and you will be signed in.'}
        </AuthBody>
        <Failure />
        {!actions ? (
          <AuthFootnote>Setup links are redeemed inside the sign-in gate.</AuthFootnote>
        ) : dead ? null : (
          <>
            <PasswordField
              value={password}
              onChange={setPassword}
              hint={`at least ${MIN_PASSWORD_LENGTH} characters — only you will know it`}
            />
            <AuthAction onClick={() => void actions.redeemSetup(token, password)}>
              {actions.busy ? 'Setting password…' : 'Set password and sign in'}
            </AuthAction>
            {who ? <AuthFootnote>{`Link expires ${new Date(who.expiresAt).toLocaleString()}.`}</AuthFootnote> : null}
          </>
        )}
        {actions ? <SignInSwitch onFrameChange={props.onFrameChange} label="I already have a password — sign in" /> : null}
      </AuthCard>
    </AuthStage>
  );
}

/** 1s — create an account with the invite you opened, and join its space. */
export function FrameInviteSignup(props: FrameProps) {
  const actions = useAuthActions();
  const code = actions?.inviteCode ?? '';
  const [name, setName] = useState('');
  const [password, setPassword] = useState('');
  const [spacePassword, setSpacePassword] = useState('');
  const handle = handleFrom(name);
  const askSpacePassword = actions?.failure?.kind === 'server-refused' && /space password/i.test(actions.failure.message);
  return (
    <AuthStage meta={activeNodeLabel()}>
      <AuthCard>
        <AuthEyebrow>INVITATION</AuthEyebrow>
        <AuthTitle>Create your account to join</AuthTitle>
        <AuthBody>
          You opened an invite to a space on this server. Pick a name and a password; the account is created with
          the invite and you join the space in the same step. Nobody else learns your password.
        </AuthBody>
        <Failure />
        {!actions || !code ? (
          <AuthFootnote>Invite sign-up runs inside the sign-in gate, with the invite you opened.</AuthFootnote>
        ) : (
          <>
            <AuthField
              label="YOUR NAME"
              value={name}
              onChange={setName}
              state="focus"
              hint={handle ? `handle @${handle}` : 'your handle is made from it'}
            />
            <PasswordField value={password} onChange={setPassword} hint={`at least ${MIN_PASSWORD_LENGTH} characters`} />
            {askSpacePassword ? (
              <AuthField
                label="SPACE PASSWORD"
                type="password"
                value={spacePassword}
                onChange={setSpacePassword}
                hint="this space asks for its own password too — the person who invited you has it"
              />
            ) : null}
            <AuthAction onClick={() => void actions.inviteSignup(code, name, password, spacePassword || undefined)}>
              {actions.busy ? 'Creating account…' : 'Create account and join'}
            </AuthAction>
          </>
        )}
        {actions ? <SignInSwitch onFrameChange={props.onFrameChange} label="I already have an account — sign in" /> : null}
      </AuthCard>
    </AuthStage>
  );
}
