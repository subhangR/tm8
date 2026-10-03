/**
 * FLOW A · FIRST RUN (T3-1) — 1a claim · 1b name the server · 1c first space.
 *
 * "Today tm8 silently auto-signs-in on localhost. The moment it leaves one
 * machine: first boot serves three steps" (oracle L29). Step 1 is REAL inside
 * the gate — auth.claim on an unclaimed node, auth.signup otherwise, then
 * auth.login. Steps 2 and 3 still have no executor (see reasons.ts) and refuse
 * their terminal act; the step navigation between them is real client nav.
 *
 * WHERE THE THREE STEPS ACTUALLY LIVE (design §10.1, ruled 2026-08-16). The
 * oracle drew a three-step gate wizard; the truthful build is a ONE-step gate
 * plus the app's own onboarding, and that is deliberate, not unfinished:
 *   · 1a (you) is the gate's whole job — and claiming SIGNS YOU IN, so the
 *     gate closes here by design (§3.2). The counter is hidden in the live
 *     gate for exactly that reason (see FrameClaim).
 *   · 1c (first space) is delivered by the app's post-claim ZERO-SPACES
 *     WELCOME (views/GateApp.tsx) handing off to the existing, far more
 *     capable NewSpaceProjectDialog (creates the Space, optionally connects a
 *     project, records a memory). A gate-internal 1c would be a strictly worse
 *     DUPLICATE of that surface, so it hands off instead of re-implementing.
 *   · 1b (name the server) has NO backing operation — nothing in the catalog
 *     sets the local node's own name (serverConnections.* name only REMOTE
 *     routes). So it is never promised in the live gate; wiring a local-only
 *     field that pretended to persist would be the lie this module refuses.
 * 1b and 1c stay on the REVIEW BOARD as the oracle's drawings, refusing as
 * built — that is the design record, and it is not a live promise.
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
import { activeNodeLabel } from '../servers/server-key';
import { failureCopy } from './failures';
import { handleFrom } from './session';
import { CLAIM, FIRST_SPACE, NAME_STEP, SERVER } from './specimen';
import { CLAIM_TOKEN_REQUIRED, CREATE_OWNER, CREATE_SPACE, NAME_SERVER } from './reasons';
import type { FrameProps } from './types';

/**
 * The `#claim=` token the server printed in its boot link.
 *
 * A FRAGMENT, NOT A QUERY STRING, and that is the whole point: browsers never
 * send the fragment to the server, so the token cannot reach an access log, an
 * upstream proxy, or a `Referer`. An earlier revision used `?claim=`, which
 * would have written a node-ownership capability into the nginx log of exactly
 * the reverse-proxied deployment this feature exists to serve — before the
 * ceremony burns it. Same click for the operator, no disclosure.
 *
 * Read once at mount rather than watched: the field is the state after that,
 * so a viewer editing it is not fighting the URL. The fragment is scrubbed
 * immediately (see below) so it does not linger in the address bar or in
 * session history.
 */
function readClaimTokenFromUrl(): string {
  try {
    const hash = globalThis.location?.hash ?? '';
    const token = new URLSearchParams(hash.replace(/^#/, '')).get('claim')?.trim() ?? '';
    if (token && globalThis.history?.replaceState) {
      // Out of the address bar the moment it is in the field. The token is
      // still single-use and still burned server-side; this only stops a
      // shoulder-surfer, a screenshot or a back-button from carrying it.
      const { pathname, search } = globalThis.location;
      globalThis.history.replaceState(null, '', `${pathname}${search}`);
    }
    return token;
  } catch {
    return '';
  }
}

/**
 * ONCE PER PAGE LOAD, not once per mount — and that distinction is the whole
 * reason this exists.
 *
 * `readClaimTokenFromUrl` is not pure: reading the fragment SCRUBS it. Calling
 * an impure function from a `useState` initializer means the second caller sees
 * a URL the first one already emptied, and under `<React.StrictMode>` — which
 * `main.tsx` wraps the app in — there is always a second caller. Strict mode
 * double-invokes the render and then deliberately unmounts and remounts, and a
 * remount re-runs the initializer against fresh hook state. So:
 *
 *   mount   → reads `tok`, scrubs the fragment
 *   remount → reads the scrubbed fragment, gets `''`
 *
 * and the field the printed link exists to fill arrives EMPTY. The operator
 * clicks the one-time setup link the server told them to click, lands on a card
 * whose own copy says "open that link and the code below fills itself in", and
 * the code is not there — with `Create account` disabled underneath and no way
 * to tell whether the link, the token or the server is at fault. Measured in a
 * real browser against a dev node on 2026-08-22.
 *
 * Memoising the READ, rather than making it pure and scrubbing in an effect,
 * is what actually fixes it: an effect scrub still leaves the remount's
 * initializer reading an emptied fragment. The capture is keyed to the document,
 * which is exactly the lifetime the fragment has.
 */
let capturedClaimToken: string | undefined;
function claimTokenOnce(): string {
  capturedClaimToken ??= readClaimTokenFromUrl();
  return capturedClaimToken;
}

/**
 * 1a — Claim, step 1 · you. Oracle L33–L47.
 *
 * INSIDE THE GATE this is a REAL act: it creates the account ON THE SERVER
 * (auth.signup) and signs you in (auth.login). Outside it (the review board)
 * the identical component refuses, because the executor arrives through
 * context and nothing else changes.
 *
 * WHY IT COMPLETES AT STEP 1 OF 3, and why the dots say 1 of 3 ON THE BOARD
 * ONLY. The oracle draws three first-run steps: you, the server, the first
 * space. Steps 2 and 3 have NO operation behind them — nothing sets a server's
 * name, and `spaces.create` is a contract op the seam does not expose. The
 * acceptance loop has to land in the app, so the gate completes here. Frames
 * 1b and 1c remain on the review board, drawn as designed and refusing as
 * built, and there the counter and the disclosure note both belong.
 *
 * IN THE LIVE GATE THEY DO NOT, and that was a real defect rather than a
 * quibble. Pixel-verified 2026-08-05: a first-time viewer met "STEP 1 OF 3"
 * over three progress dots, finished, and was in — a progress indicator that
 * promises two more steps and then never shows them. Below it sat a paragraph
 * naming "the oracle", "the seam" and `spaces.create`: a note written for a
 * reviewer reading the design against the build, rendered to somebody who has
 * seen neither. Correct reasoning, wrong audience.
 *
 * So the same `actions` seam this file already branches on everywhere else
 * decides both: the board keeps the designed counter and the disclosure, the
 * gate says FIRST RUN and shows the one step that exists. Neither reader is
 * lied to, and the oracle transcription in `specimen.ts` is untouched.
 */
export function FrameClaim(props: FrameProps) {
  const actions = useAuthActions();
  const [name, setName] = useState('');
  const [password, setPassword] = useState('');
  const [show, setShow] = useState(false);
  // Prefilled from `?claim=` so the printed link is one click. It stays an
  // EDITABLE field rather than a hidden value: an operator who copied the
  // token out of `<dataDir>/setup-token` has no link to click, and a hidden
  // field would leave them with a card they cannot complete.
  const [token, setToken] = useState(claimTokenOnce);
  const handle = handleFrom(name);
  const failure = actions?.failure;
  // "Another" is a different moment from "first run", and the card says so:
  // the first-run copy claims an unclaimed server, which is false the second
  // time through.
  const another = (actions?.accounts.length ?? 0) > 0;

  // WHICH ACT THIS CARD PERFORMS IS THE NODE'S ANSWER, not an inference.
  //
  // Unclaimed: `auth.claim`, authorized by the setup token — the path that
  // works from a device that is not the server, and the one that closes the
  // dead end this card used to walk people into. Claimed: `auth.signup`,
  // authorized by node admin, which is the pre-existing "create another
  // account" act and is unchanged.
  //
  // A node that has not answered is treated as CLAIMED, so an unreachable
  // node never renders a ceremony that cannot succeed.
  const unclaimed = actions?.nodeClaim?.claimed === false;
  const submit = unclaimed
    ? () => void actions?.claimNode(token, name, password)
    : () => void actions?.createAccount(name, password);

  return (
    // Defect fix: on the review board the chrome carries the oracle's own
    // specimen line; the LIVE gate carries the node's REAL origin. Showing
    // `SERVER.unclaimedMeta` ('tm8-server v0.9.2 · localhost:8787') to a real
    // operator told them the wrong host, wrong port and an invented version at
    // the exact moment they were handing over ownership. `activeNodeLabel()`
    // reads the node this browser is actually pointed at.
    <AuthStage meta={actions ? activeNodeLabel() : SERVER.unclaimedMeta}>
      <AuthCard>
        <div className="auth-card__head">
          <AuthEyebrow>{actions ? 'FIRST RUN' : 'FIRST RUN · STEP 1 OF 3'}</AuthEyebrow>
          <span className="auth-spacer" />
          {actions ? null : <AuthSteps of={3} at={1} />}
        </div>
        <AuthTitle>
          {another
            ? CLAIM.anotherTitle
            : !actions
              ? CLAIM.title
              : unclaimed
                ? CLAIM.claimTitle
                : CLAIM.gateTitle}
        </AuthTitle>
        {/* The body has to describe the act the card actually performs. On an
            unclaimed node that is `auth.claim` (token-authorized, works from
            any machine); the old copy described `auth.signup` and its shared-
            server dead end — the very door the claim lane removes. See
            `unclaimed` above: it is the node's own answer, not an inference. */}
        <AuthBody>
          {!actions
            ? CLAIM.body
            : another
              ? CLAIM.anotherBody
              : unclaimed
                ? CLAIM.claimBody
                : CLAIM.gateBody}
        </AuthBody>

        {failure ? (
          <AuthFailureBanner>
            <b className="auth-alert__lead">{failureCopy(failure).lead}</b>
            {failureCopy(failure).body}
          </AuthFailureBanner>
        ) : null}

        {actions ? (
          <>
            {unclaimed ? (
              <AuthField
                label="SETUP TOKEN"
                value={token}
                onChange={setToken}
                hint={
                  token
                    ? 'filled in from the setup link \u2014 it works once, and is used up when you claim'
                    : 'tm8 printed a setup link in the terminal when it started \u2014 open that link and this fills itself in. Lost it? Start tm8 again and it prints the same link.'
                }
              />
            ) : null}
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
            {!unclaimed || token.trim() ? (
              <AuthAction onClick={submit}>
                {actions.busy ? CLAIM.actionBusy : another ? CLAIM.anotherAction : CLAIM.gateAction}
              </AuthAction>
            ) : (
              // Disabled-with-reason, per the module's own honesty law: an
              // enabled button here would promise an act the server must
              // refuse, which is the precise defect this lane closes.
              <AuthAction reason={CLAIM_TOKEN_REQUIRED}>
                {another ? CLAIM.anotherAction : CLAIM.gateAction}
              </AuthAction>
            )}
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

        {/* The step-2/3 disclosure — BOARD ONLY. It names the operations so a
            reviewer can tell when they arrive; in the gate it is a note about
            two steps the viewer will never be shown, written in vocabulary
            they do not have. See the header comment. */}
        {actions ? null : <AuthCaption>{CLAIM.stepsNote}</AuthCaption>}
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
