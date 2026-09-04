/**
 * THE SIGN-IN PAGE — the owner's design, wired to this node's real verbs.
 *
 * WHAT WAS TRANSCRIBED AND WHAT WAS NOT. The design arrived as a standalone
 * Vite app talking REST (`POST /api/auth/login`, `/api/auth/oauth/github`, …).
 * None of those paths exist here: tm8 signs in through `auth.login` over the
 * seam and mints a revocable `tm8s_` pass stored per server. So the LAYOUT,
 * spacing, type and colour are transcribed and the TRANSPORT is this package's
 * own — which is also what the owner asked for, since the credential shape is
 * unchanged. `AuthLoginInput` is literally `{ username, password }`, so the
 * design's payload and this node's are already the same object.
 *
 * THE FOUR CONTROLS WITH NOTHING BEHIND THEM. The design draws three OAuth
 * providers, a forgot-password link, a remember-me box and an access-token tab.
 * Measured against the server, which publishes exactly ten auth operations,
 * NONE of the first two has an implementation and none is planned in the
 * contract — the catalog says the password reset is omitted deliberately. Under
 * the owner's ruling the providers and the forgot link SHIP, drawn exactly as
 * designed, wearing this package's refusal treatment: present, legible, and
 * saying out loud what they cannot do. Remember-me and the token tab were ruled
 * off the page, so they are absent rather than decorative — remember-me because
 * the pass already persists per server (the box would have described behaviour
 * that happens anyway), and the token tab because no operation redeems a pasted
 * token.
 *
 * That is the same law `AuthAction`'s refusal skin already enforces everywhere
 * else in this flow, applied to three more buttons and a link. A sign-in page
 * that pretends to authenticate is the worst lie this app could tell; a sign-in
 * page that pretends GitHub will work is the second worst.
 */
import { useState, type ReactNode } from 'react';
import { RibbonMark, VectorIcon } from '../kit';
import { KIND_ART } from '../domain/kind-art';
import { SIGNIN_ART } from './signin-art';
import { useTheme } from '../theme/useTheme';
import { DisabledAction } from '../panels/honesty/DisabledWithReason';
import type { UnavailableReason } from '../panels/honesty/DisabledWithReason';
import { FORGOT_PASSWORD, SIGN_IN_OAUTH, SIGN_IN_PASSWORD } from './reasons';
import { LOGIN, SERVER } from './specimen';

/* ── the module rows ─────────────────────────────────────────────────────── */

/**
 * The six modules' artwork, and where each drawing comes from.
 *
 * Four of the six ARE tm8 kinds and take the kind registry's own mark, so the
 * front door and the entity rail draw the same task. Only the two that are not
 * kinds are authored locally. The tones are the design's.
 */
const MODULE_ART: Record<string, readonly string[]> = {
  task: KIND_ART.task,
  work_session: KIND_ART.work_session,
  message: KIND_ART.message,
  doc: KIND_ART.doc,
  collab: SIGNIN_ART.collab,
  multiAgent: SIGNIN_ART.multiAgent,
};

const MODULE_TONE: Record<string, string> = {
  task: 'green',
  work_session: 'blue',
  message: 'purple',
  collab: 'pink',
  multiAgent: 'violet',
  doc: 'orange',
};

function ModuleRow({
  artKey,
  title,
  text,
  badge,
}: {
  artKey: string;
  title: string;
  text: string;
  badge?: string;
}) {
  return (
    /* A DIV, NOT A BUTTON OR A LINK. The design draws a chevron on each row and
       a chevron reads as "this goes somewhere" — but signed out there is
       nowhere for it to go, and a row that moves on hover and does nothing on
       click is a worse lie than a row that never offered. The chevron stays as
       the design's punctuation; the row is inert and says so by being a div. */
    <div className="sp-mod">
      <span className={`sp-mod__icon sp-mod__icon--${MODULE_TONE[artKey] ?? 'blue'}`}>
        <VectorIcon paths={MODULE_ART[artKey] ?? []} size={18} strokeWidth={1.5} />
      </span>
      <span className="sp-mod__copy">
        <span className="sp-mod__titleline">
          <strong>{title}</strong>
          {badge ? <span className="sp-mod__badge">{badge}</span> : null}
        </span>
        <span className="sp-mod__text">{text}</span>
      </span>
      <VectorIcon
        paths={SIGNIN_ART.arrowRight}
        size={16}
        strokeWidth={1.5}
        className="sp-mod__arrow"
      />
    </div>
  );
}

/* ── refusal-wearing controls ────────────────────────────────────────────── */

/**
 * A provider button that cannot sign anybody in.
 *
 * `DisabledAction` IS THE TREATMENT, not a lookalike. The first draft here
 * hand-rolled the role/aria-disabled/aria-describedby triple and its own
 * caption, which is how a fourth refusal treatment gets born — the exact thing
 * T4's matrix rule forbids. This wears the shipped one and only styles the
 * chrome around it, so a change to the honesty law reaches this page for free.
 */
function RefusedProvider({
  reason,
  glyph,
  children,
}: {
  reason: UnavailableReason;
  glyph: ReactNode;
  children: ReactNode;
}) {
  return (
    <span className="sp-prov">
      <DisabledAction reason={reason} label={`Sign in with ${children}`}>
        <span className="sp-prov__face">
          {glyph}
          <span>{children}</span>
        </span>
      </DisabledAction>
    </span>
  );
}

/* The three provider marks. Authored here rather than imported for the same
   reason as `signin-art`: one icon vocabulary per product. */
const GITHUB_PATH =
  'M8 1.3a6.7 6.7 0 0 0-2.1 13.1c.33.06.45-.15.45-.33v-1.15c-1.86.4-2.25-.9-2.25-.9-.3-.77-.74-.98-.74-.98-.61-.41.05-.4.05-.4.67.05 1.02.69 1.02.69.6 1.02 1.57.73 1.95.56.06-.43.23-.73.42-.9-1.48-.17-3.04-.74-3.04-3.3 0-.73.26-1.32.69-1.79-.07-.17-.3-.85.06-1.77 0 0 .56-.18 1.84.68a6.4 6.4 0 0 1 3.35 0c1.27-.86 1.83-.68 1.83-.68.37.92.14 1.6.07 1.77.43.47.69 1.06.69 1.79 0 2.56-1.56 3.13-3.05 3.29.24.21.45.61.45 1.24v1.84c0 .18.12.39.46.33A6.7 6.7 0 0 0 8 1.3z';
const GIT_PATHS = [
  'M14.2 7.2 8.8 1.8a1.1 1.1 0 0 0-1.6 0L6 3l1.5 1.5a1.3 1.3 0 0 1 1.7 1.7l1.45 1.45a1.3 1.3 0 1 1-.8.75L8.5 7.05v3.8a1.3 1.3 0 1 1-1.1-.03V6.98a1.3 1.3 0 0 1-.7-1.7L5.2 3.8 1.8 7.2a1.1 1.1 0 0 0 0 1.6l5.4 5.4a1.1 1.1 0 0 0 1.6 0l5.4-5.4a1.1 1.1 0 0 0 0-1.6z',
];
const GOOGLE_PATHS = [
  'M14.3 8.15c0-.5-.05-.98-.13-1.44H8v2.73h3.53a3.02 3.02 0 0 1-1.31 1.98v1.65h2.12c1.24-1.14 1.96-2.82 1.96-4.92z',
  'M8 14.7c1.77 0 3.26-.59 4.34-1.59l-2.12-1.65c-.59.4-1.34.63-2.22.63-1.71 0-3.16-1.15-3.68-2.7H2.13v1.7A6.7 6.7 0 0 0 8 14.7z',
  'M4.32 9.39a4.02 4.02 0 0 1 0-2.56v-1.7H2.13a6.7 6.7 0 0 0 0 5.96l2.19-1.7z',
  'M8 4.13c.96 0 1.83.33 2.51.98l1.88-1.88A6.7 6.7 0 0 0 2.13 5.13l2.19 1.7C4.84 5.28 6.29 4.13 8 4.13z',
];

/* ── the page ────────────────────────────────────────────────────────────── */

export function SignInPage({
  serverName,
  serverMeta,
  handle,
  password,
  busy,
  failure,
  onHandle,
  onPassword,
  onSubmit,
  onCreateAccount,
}: {
  /** The node being signed into, or null on the review board. */
  serverName: string | null;
  serverMeta: string;
  handle: string;
  password: string;
  busy: boolean;
  /** Rendered above the primary. Null when there is nothing to report. */
  failure: ReactNode;
  onHandle: ((v: string) => void) | null;
  onPassword: ((v: string) => void) | null;
  onSubmit: (() => void) | null;
  /**
   * The SECOND path to an account, and it is truthful only where an
   * unauthenticated signup can actually run: the loopback auto-owner. Null
   * everywhere else, and then the row is absent rather than refused —
   * advertising it on a remote node leads to a refusal the viewer cannot
   * resolve, which is the dead end this whole lane exists to close.
   */
  onCreateAccount: (() => void) | null;
}) {
  const { theme, setTheme } = useTheme();
  const [show, setShow] = useState(false);
  const live = Boolean(onSubmit);

  return (
    <div className="sp-page">
      <div className="sp-page__grid" aria-hidden="true" />
      <div className="sp-page__glow sp-page__glow--a" aria-hidden="true" />
      <div className="sp-page__glow sp-page__glow--b" aria-hidden="true" />

      <header className="sp-top">
        <span className="sp-logo">
          <span className="sp-logo__letters">tm</span>
          <RibbonMark className="sp-logo__eight" layout="wordmark" animated={false} />
        </span>
        <span className="sp-top__actions">
          <span className="sp-top__meta">{serverMeta}</span>
          <button
            type="button"
            className="sp-theme"
            aria-label={`Switch to ${theme === 'dark' ? 'light' : 'dark'} mode`}
            onClick={() => setTheme(theme === 'dark' ? 'light' : 'dark')}
          >
            <span className={theme === 'light' ? 'is-on' : undefined}>
              <VectorIcon paths={SIGNIN_ART.sun} size={15} strokeWidth={1.5} />
            </span>
            <span className={theme === 'dark' ? 'is-on' : undefined}>
              <VectorIcon paths={SIGNIN_ART.moon} size={15} strokeWidth={1.5} />
            </span>
          </button>
        </span>
      </header>

      <main className="sp-main">
        <section className="sp-product" aria-label="tm8 product overview">
          <div className="sp-product__eyebrow">{LOGIN.eyebrow}</div>
          <h1 className="sp-product__title">
            {LOGIN.headlineA}
            <br />
            <span>{LOGIN.headlineB}</span>
          </h1>
          <p className="sp-product__blurb">{LOGIN.blurb}</p>

          <div className="sp-modstack">
            {LOGIN.modules.map((m) => (
              <ModuleRow
                key={m.key}
                artKey={m.key}
                title={m.title}
                text={m.text}
                badge={'badge' in m ? m.badge : undefined}
              />
            ))}
          </div>

          <div className="sp-audience">
            {LOGIN.audience.map((a, i) => (
              <div className="sp-audience__slot" key={a.key}>
                {i > 0 ? <span className="sp-audience__rule" aria-hidden="true" /> : null}
                <div className="sp-audience__item">
                  <VectorIcon
                    paths={SIGNIN_ART[a.key as 'team' | 'individual']}
                    size={19}
                    strokeWidth={1.5}
                  />
                  <div>
                    <strong>{a.title}</strong>
                    <span>{a.text}</span>
                  </div>
                </div>
              </div>
            ))}
          </div>
        </section>

        <section className="sp-card" aria-labelledby="sp-card-title">
          <span className="sp-card__badge" aria-hidden="true">
            <VectorIcon paths={SIGNIN_ART.key} size={18} strokeWidth={1.5} />
          </span>

          <h2 className="sp-card__title" id="sp-card-title">
            {LOGIN.title}
          </h2>
          <p className="sp-card__sub">{LOGIN.subtitle}</p>

          {/* The node being signed into, named. The design has no such line —
              it assumes one hosted product — but tm8 is many servers behind one
              client, and which node is about to take this password is the one
              fact a viewer cannot infer. */}
          {serverName ? (
            <div className="sp-card__server">
              <span className="sp-card__serverglyph">{serverName[0]!.toUpperCase()}</span>
              <span>
                <strong>{serverName}</strong>
                <em>{SERVER.localEndpoint}</em>
              </span>
            </div>
          ) : null}

          <form
            className="sp-form"
            onSubmit={(e) => {
              e.preventDefault();
              onSubmit?.();
            }}
          >
            <label className="sp-field__label" htmlFor="sp-username">
              {LOGIN.handleLabel}
            </label>
            <div className="sp-field">
              <VectorIcon paths={SIGNIN_ART.user} size={18} strokeWidth={1.5} />
              <input
                id="sp-username"
                value={handle}
                placeholder={LOGIN.handlePlaceholder}
                autoComplete="username"
                readOnly={!live}
                onChange={(e) => onHandle?.(e.target.value)}
              />
            </div>

            <label className="sp-field__label" htmlFor="sp-password">
              {LOGIN.passwordLabel}
            </label>
            <div className="sp-field" data-state={failure ? 'error' : undefined}>
              <VectorIcon paths={SIGNIN_ART.lock} size={18} strokeWidth={1.5} />
              <input
                id="sp-password"
                type={show ? 'text' : 'password'}
                value={password}
                placeholder={LOGIN.passwordPlaceholder}
                autoComplete="current-password"
                readOnly={!live}
                onChange={(e) => onPassword?.(e.target.value)}
              />
              <button
                type="button"
                className="sp-field__reveal"
                data-nav="reveal"
                aria-label={show ? 'Hide password' : 'Show password'}
                onClick={() => setShow((v) => !v)}
              >
                <VectorIcon
                  paths={show ? SIGNIN_ART.eyeOff : SIGNIN_ART.eye}
                  size={17}
                  strokeWidth={1.5}
                />
              </button>
            </div>

            {/* The design pairs this row with a remember-me box. Ruled off: the
                pass already persists per server, so the box would have
                described something that happens whether it is ticked or not. */}
            <div className="sp-form__row">
              <RefusedLink reason={FORGOT_PASSWORD}>{LOGIN.forgot}</RefusedLink>
            </div>

            {failure}

            {/* NEVER NATIVELY `disabled` WHEN THERE IS NO EXECUTOR.
                The first build wrote `disabled={!live || busy}`, which collapses
                two different facts into one attribute: `busy` is a transient
                state of a control that WORKS, and `!live` means there is no
                verb behind it at all. A natively disabled button is also
                unfocusable, so its reason becomes unreachable by keyboard —
                which is exactly what D28 forbids and what
                `auth.test.tsx` caught. Outside the gate this wears the same
                refusal every other verb in this flow wears; inside it, it is a
                real submit that may be momentarily busy. */}
            {live ? (
              <button type="submit" className="sp-primary" disabled={busy}>
                <span>{busy ? LOGIN.busyAction : LOGIN.passwordAction}</span>
                <VectorIcon paths={SIGNIN_ART.arrowRight} size={18} strokeWidth={2} />
              </button>
            ) : (
              <span className="sp-primary sp-primary--refused">
                <DisabledAction reason={SIGN_IN_PASSWORD} label={LOGIN.passwordAction}>
                  <span className="sp-primary__face">
                    <span>{LOGIN.passwordAction}</span>
                    <VectorIcon paths={SIGNIN_ART.arrowRight} size={18} strokeWidth={2} />
                  </span>
                </DisabledAction>
              </span>
            )}
          </form>

          <div className="sp-sep">
            <span />
            <em>{LOGIN.orContinue}</em>
            <span />
          </div>

          <div className="sp-provs">
            <RefusedProvider
              reason={SIGN_IN_OAUTH}
              glyph={<VectorIcon paths={[GITHUB_PATH]} size={17} filled />}
            >
              GitHub
            </RefusedProvider>
            <RefusedProvider
              reason={SIGN_IN_OAUTH}
              glyph={<VectorIcon paths={GIT_PATHS} size={17} filled />}
            >
              Git
            </RefusedProvider>
            <RefusedProvider
              reason={SIGN_IN_OAUTH}
              glyph={<VectorIcon paths={GOOGLE_PATHS} size={17} filled />}
            >
              Google
            </RefusedProvider>
          </div>

          {onCreateAccount ? (
            <div className="sp-account">
              <span>{LOGIN.newHere}</span>
              <button type="button" className="sp-account__link" data-nav="frame" onClick={onCreateAccount}>
                {LOGIN.toCreateAnother}
              </button>
            </div>
          ) : null}

          <p className="sp-card__foot">{LOGIN.gateFooter}</p>
        </section>
      </main>
    </div>
  );
}

/** The forgot-password link, wearing the same refusal as the providers. */
function RefusedLink({ reason, children }: { reason: UnavailableReason; children: ReactNode }) {
  return (
    <span className="sp-forgot">
      <DisabledAction reason={reason} label="Forgot password">
        {children}
      </DisabledAction>
    </span>
  );
}
