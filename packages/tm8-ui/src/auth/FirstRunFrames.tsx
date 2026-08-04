/**
 * FLOW A · FIRST RUN (T3-1) — 1a claim · 1b name the server · 1c first space.
 *
 * "Today tm8 silently auto-signs-in on localhost. The moment it leaves one
 * machine: first boot serves three steps" (oracle L29). Step 1 is REAL inside
 * the gate — auth.signup + auth.login against the active server. Steps 2 and
 * 3 still have no executor (see reasons.ts) and refuse their terminal act;
 * the step navigation between them is real client nav.
 */
import { useState } from 'react';
import {
  AuthAction,
  AuthBody,
  AuthCaption,
  AuthCard,
  AuthEyebrow,
  AuthFailureBanner,
  AuthField,
  AuthFootnote,
  AuthServerTile,
  AuthStage,
  AuthSteps,
  AuthTitle,
} from './AuthCard';
import { useAuthActions } from './gate-context';
import { failureCopy } from './failures';
import { handleFrom } from './session';
import { CLAIM, FIRST_SPACE, NAME_STEP, SERVER } from './specimen';
import { CREATE_OWNER, CREATE_SPACE, NAME_SERVER } from './reasons';
import type { FrameProps } from './types';

/**
 * 1a — Claim, step 1 · you. Oracle L33–L47.
 *
 * INSIDE THE GATE this is a REAL act: it creates the account ON THE SERVER
 * (auth.signup) and signs you in (auth.login). Outside it (the review board)
 * the identical component refuses, because the executor arrives through
 * context and nothing else changes.
 *
 * WHY IT COMPLETES AT STEP 1 OF 3, and why the dots still say 1 of 3. The
 * oracle draws three first-run steps: you, the server, the first space. Steps
 * 2 and 3 have NO operation behind them — nothing sets a server's name, and
 * `spaces.create` is a contract op the seam does not expose. The acceptance
 * loop has to land in the app, so the gate completes here. The dots are not
 * adjusted to say "1 of 1" because that would be the lie in a different place:
 * you ARE at step 1 of a designed 3, and the note below says the other two
 * cannot run and why. Frames 1b and 1c remain on the review board, drawn as
 * designed and refusing as built.
 */
export function FrameClaim(props: FrameProps) {
  const actions = useAuthActions();
  const [name, setName] = useState('');
  const [password, setPassword] = useState('');
  const [show, setShow] = useState(false);
  const handle = handleFrom(name);
  const failure = actions?.failure;
  // "Another" is a different moment from "first run", and the card says so:
  // the first-run copy claims an unclaimed server, which is false the second
  // time through.
  const another = (actions?.accounts.length ?? 0) > 0;

  const submit = () => void actions?.createAccount(name, password);

  return (
    <AuthStage meta={SERVER.unclaimedMeta}>
      <AuthCard>
        <div className="auth-card__head">
          <AuthEyebrow>FIRST RUN · STEP 1 OF 3</AuthEyebrow>
          <span className="auth-spacer" />
          <AuthSteps of={3} at={1} />
        </div>
        <AuthTitle>
          {another ? CLAIM.anotherTitle : actions ? CLAIM.gateTitle : CLAIM.title}
        </AuthTitle>
        <AuthBody>
          {!actions ? CLAIM.body : another ? CLAIM.anotherBody : CLAIM.gateBody}
        </AuthBody>

        {failure ? (
          <AuthFailureBanner>
            <b className="auth-alert__lead">{failureCopy(failure).lead}</b>
            {failureCopy(failure).body}
          </AuthFailureBanner>
        ) : null}

        {actions ? (
          <>
            <AuthField
              label="YOUR NAME"
              value={name}
              onChange={setName}
              state="focus"
              hint={handle ? `handle @${handle} — ${CLAIM.handleHintTail}` : CLAIM.nameHintEmpty}
            />
            <AuthField
              label="PASSWORD"
              type={show ? 'text' : 'password'}
              value={password}
              onChange={setPassword}
              hint={CLAIM.gatePasswordHint}
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
              {actions.busy ? CLAIM.actionBusy : another ? CLAIM.anotherAction : CLAIM.gateAction}
            </AuthAction>
          </>
        ) : (
          <>
            <AuthField label="YOUR NAME" value={CLAIM.name} state="focus" hint={CLAIM.nameHint} />
            <AuthField
              label="PASSWORD"
              type="password"
              value={CLAIM.password}
              hint={CLAIM.passwordHint}
              trailing={<span className="auth-field__show">show</span>}
            />
            <AuthAction reason={CREATE_OWNER}>{CLAIM.action}</AuthAction>
          </>
        )}

        {/* The step-2/3 disclosure. Named operations, so a reader can tell
            when they arrive. */}
        <AuthCaption>{CLAIM.stepsNote}</AuthCaption>
        <AuthFootnote>{actions ? CLAIM.gateFooter : CLAIM.footer}</AuthFootnote>
        {actions ? (
          <div className="auth-switch">
            <button
              type="button"
              className="auth-link"
              data-nav="frame"
              onClick={() => props.onFrameChange?.('1d')}
            >
              {another ? CLAIM.backToSignIn : CLAIM.toSignIn}
            </button>
          </div>
        ) : null}
      </AuthCard>
    </AuthStage>
  );
}

/**
 * 1b — Claim, step 2 · the server. Oracle L52–L69.
 *
 * The tile preview and the swatch row are REAL client state: the glyph is
 * derived from the typed name exactly as the oracle's own caption promises
 * ("glyph from the name", L62), and the swatch selection is local. Nothing
 * here is stored anywhere, which is what the refusal below says.
 */
export function FrameNameServer(props: FrameProps) {
  // Explicitly `string`: specimen.ts is `as const`, so inference would narrow
  // this to the literal "forge" and the field would refuse every keystroke.
  const [name, setName] = useState<string>(NAME_STEP.name);
  const [swatch, setSwatch] = useState(0);
  const glyph = (name.trim()[0] ?? SERVER.glyph).toUpperCase();

  // The four swatches the oracle draws (L65): brass, run, info, wait — the
  // functional ramp, so each re-themes for free.
  const SWATCHES = ['brand', 'run', 'info', 'wait'] as const;

  return (
    <AuthStage meta={SERVER.unclaimedMeta}>
      <AuthCard>
        <div className="auth-card__head">
          <AuthEyebrow>FIRST RUN · STEP 2 OF 3</AuthEyebrow>
          <span className="auth-spacer" />
          <AuthSteps of={3} at={2} />
        </div>
        <AuthTitle>{NAME_STEP.title}</AuthTitle>
        <AuthBody>{NAME_STEP.body}</AuthBody>

        <div className="auth-inset">
          <AuthServerTile
            glyph={glyph}
            name={name || '—'}
            meta={NAME_STEP.tilePreviewHint}
            size="lg"
            tone={SWATCHES[swatch]}
          />
        </div>

        <div className="auth-field">
          <label className="auth-field__label" htmlFor="auth-server-name">
            SERVER NAME
          </label>
          <div className="auth-field__box auth-field__box--focus">
            <input
              id="auth-server-name"
              className="auth-field__input"
              value={name}
              onChange={(e) => setName(e.target.value)}
            />
          </div>
        </div>

        <div className="auth-field">
          <span className="auth-field__label">TILE COLOR</span>
          <div className="auth-swatches" role="radiogroup" aria-label="tile color">
            {SWATCHES.map((tone, i) => (
              <button
                key={tone}
                type="button"
                role="radio"
                aria-checked={i === swatch}
                aria-label={tone}
                className={`auth-swatch auth-swatch--${tone}${i === swatch ? ' auth-swatch--on' : ''}`}
                onClick={() => setSwatch(i)}
              />
            ))}
            <span className="auth-swatch__note">
              {SWATCHES[swatch] === 'brand' ? NAME_STEP.swatchNote : `${SWATCHES[swatch]}, selected`}
            </span>
          </div>
        </div>

        <div className="auth-card__foot">
          <BackLink onClick={() => props.onFrameChange?.('1a')} />
          <span className="auth-spacer" />
          <AuthAction reason={NAME_SERVER}>{NAME_STEP.action}</AuthAction>
        </div>
      </AuthCard>
    </AuthStage>
  );
}

/** 1c — Claim, step 3 · the first space. Oracle L74–L88. */
export function FrameFirstSpace(props: FrameProps) {
  return (
    <AuthStage meta={SERVER.namedMeta}>
      <AuthCard>
        <div className="auth-card__head">
          <AuthEyebrow>FIRST RUN · STEP 3 OF 3</AuthEyebrow>
          <span className="auth-spacer" />
          <AuthSteps of={3} at={3} />
        </div>
        <AuthTitle>{FIRST_SPACE.title}</AuthTitle>
        <AuthBody>{FIRST_SPACE.body}</AuthBody>
        <AuthField label="SPACE NAME" value={FIRST_SPACE.name} state="focus" />
        {/* oracle L83: a brass dot + the menu-is-data note, in the inset box */}
        <div className="auth-inset auth-inset--note">
          <span className="auth-dot auth-dot--brand" aria-hidden />
          <span className="auth-inset__text">{FIRST_SPACE.menuNote}</span>
        </div>
        <div className="auth-card__foot">
          <BackLink onClick={() => props.onFrameChange?.('1b')} />
          <span className="auth-spacer" />
          <AuthAction reason={CREATE_SPACE}>{FIRST_SPACE.action}</AuthAction>
        </div>
        <AuthFootnote>{FIRST_SPACE.footer}</AuthFootnote>
      </AuthCard>
    </AuthStage>
  );
}

/** "← back" — 12px --pn-ink-3, hover --pn-ink-2 (oracle L66). Real nav. */
export function BackLink({ onClick, children }: { onClick?: () => void; children?: string }) {
  return (
    <button type="button" className="auth-back" onClick={onClick}>
      {children ?? '← back'}
    </button>
  );
}
