/**
 * THE GAP LEDGER, IN CODE.
 *
 * Every terminal act the T3 oracle draws that this build cannot perform, and
 * the exact reason. One file so the set is auditable in one read — a refusal
 * scattered across seventeen frames is a refusal nobody can count.
 *
 * WHAT CHANGED (Identity v2 Stage 1): the four auth operations exist and the
 * gate CALLS them — `session.ts` performs `auth.signup`, `auth.login`,
 * `auth.logout`, and verifies with `auth.session.get`. So the refusals below
 * split into two honest kinds, and each names which it is:
 *
 *  - OUTSIDE-THE-GATE refusals: the identical frame on the review board has
 *    no executor (no `AuthActionsContext`), so its verb refuses. Inside the
 *    gate the verb is live and real.
 *  - STILL-UNWIRED refusals: no operation or no wiring exists anywhere —
 *    token sign-in, server naming, invites-in-the-gate, access tokens,
 *    Phase 2 multi-server. These name the missing operation or phase.
 *
 * VOICE (T1-4, quoted from the canvas footer): "exact reason + consequence",
 * reasons name the thing that is missing so they read as fact, not apology.
 * `auth.test.tsx` asserts no reason here says "coming soon" and that every one
 * names a seam/contract/operation/phase — the copy is under test because the
 * copy IS the honesty.
 */
import type { UnavailableReason } from '../panels/honesty/DisabledWithReason';

/**
 * THE OPERATIONS THE GATE PERFORMS. Formerly `MISSING_AUTH_OPS` — the ask the
 * UI flagged to the program lead, which landed as v1 operations. Kept exported
 * under the new name so the ask, the code, and the greps stay aligned:
 * `session.ts` calls exactly these four.
 *
 *   auth.signup       POST /v2/auth/signup    → create an account (node-admin gated)
 *   auth.login        POST /v2/auth/login     → handle+password → `tm8s_…` session pass
 *   auth.logout       POST /v2/auth/logout    → revoke the presented session
 *   auth.session.get  GET  /v2/auth/session   → is this session still valid, and whose
 */
export const GATE_AUTH_OPS = [
  'auth.signup',
  'auth.login',
  'auth.logout',
  'auth.session.get',
] as const;

/** 1a — create the owner account (review board only; the gate's copy is live). */
export const CREATE_OWNER: UnavailableReason = {
  cause: 'Creating an account isn’t connected here',
  remedy: 'this surface renders outside the auth gate and has no executor — inside the gate this verb performs auth.signup and auth.login for real',
};

/**
 * 1a — the claim button with no token in the field.
 *
 * NOT a missing operation: `auth.claim` exists and works. The act is refused
 * because the CALLER has not supplied the capability that authorizes it, and
 * saying so is the difference between a card that teaches and one that fails
 * at the server with a 28000.
 */
export const CLAIM_TOKEN_REQUIRED: UnavailableReason = {
  cause: 'This server needs its one-time setup code before it can be claimed',
  // `<dataDir>` is a documentation placeholder and was being rendered to a
  // human verbatim. The actionable answer needs no path: the link is in the
  // terminal they started tm8 in, and an ordinary restart REPRINTS the same
  // live token rather than rotating it (see identity/node-claim-boot.ts).
  remedy: 'tm8 printed a setup link in the terminal when it started — open that link and the code fills itself in. Lost it? Start tm8 again and it prints the same link.',
};

/** 1b — name the server / pick its tile. */
export const NAME_SERVER: UnavailableReason = {
  cause: 'Naming this server isn’t connected',
  remedy: 'no server-identity operation exists in the contract catalog; the name and tile have nowhere to be stored',
};

/**
 * 1c — create the first space. The op EXISTS server-side; the seam does not
 * carry it. D13 already ruled the same refusal for the tab bar's `+`.
 */
export const CREATE_SPACE: UnavailableReason = {
  cause: 'Creating a space isn’t connected',
  remedy: 'spaces.create is a v1 contract op the stamped seam does not expose (same gap D13 rules for the tab bar’s +)',
};

/** 1d — sign in with a handle and password (review board only). */
export const SIGN_IN_PASSWORD: UnavailableReason = {
  cause: 'Sign-in isn’t connected here',
  remedy: 'this surface renders outside the auth gate and has no executor — inside the gate this verb performs auth.login and stores the tm8s_ pass per server',
};

/**
 * 1d — the third-party providers.
 *
 * MEASURED, NOT ASSUMED. The server publishes exactly ten auth operations:
 * `auth.claim`, `auth.claim.reissue`, `auth.claim.status`, `auth.invite.resolve`,
 * `auth.invite.signup`, `auth.login`, `auth.logout`, `auth.password.change`,
 * `auth.session.get`, `auth.signup`. None of them is an OAuth exchange, and
 * there is no redirect endpoint behind any provider. The supplied design ships
 * these three live, pointed at `/api/auth/oauth/<provider>`, which on this node
 * is a 404 — so they render, at full fidelity, refusing.
 */
export const SIGN_IN_OAUTH: UnavailableReason = {
  cause: 'No third-party sign-in on this server',
  remedy:
    'this node publishes ten auth operations and none of them is an OAuth exchange — sign in with the username and password an admin issued you',
};

/**
 * 1d — the forgot-password link.
 *
 * The absence here is DELIBERATE and documented upstream: the contract catalog
 * says `auth.password.change` "demands the CURRENT password" and that a
 * reset-without-the-old-password path is omitted on purpose, because it needs
 * an out-of-band channel this node does not have. So the link is not missing
 * pending work; it is refused, and the remedy names who can actually help.
 */
export const FORGOT_PASSWORD: UnavailableReason = {
  cause: 'No self-serve password reset here',
  remedy:
    'the only password operation here is auth.password.change, which demands the current password — with no email channel on this node a reset goes through an admin, who can set a new one under Members',
};

/** 1d — sign in with an access token. */
export const SIGN_IN_TOKEN: UnavailableReason = {
  cause: 'Token sign-in isn’t connected',
  remedy: 'no operation redeems a pasted token — auth.login exchanges a handle and password, and the tm8s_ pass it mints is stored, never re-entered',
};

/** 1e — retry after a failed sign-in (review board only). */
export const SIGN_IN_RETRY: UnavailableReason = {
  cause: 'Retrying sign-in isn’t connected here',
  remedy: 'this surface renders outside the auth gate — inside it, submitting again IS the retry via auth.login; nothing enforces the attempt counter this card draws',
};

/** 1f — re-authenticate in place after expiry. */
export const REAUTH: UnavailableReason = {
  cause: 'Re-authenticating in place isn’t connected',
  remedy: 'auth.session.get verifies the pass on load only — no expiry signal reaches this modal mid-session, so its in-place re-auth has no trigger or executor',
};

/** 1f — sign in as someone else, which drops the kept view. */
export const SWITCH_ACCOUNT: UnavailableReason = {
  cause: 'Switching accounts isn’t connected here',
  remedy: 'not wired in this modal — sign out and sign back in; the gate performs auth.login for either account',
};

/** 1g — sign back in from the signed-out landing (review board only). */
export const SIGN_BACK_IN: UnavailableReason = {
  cause: 'Signing back in isn’t connected here',
  remedy: 'this surface renders outside the auth gate — inside it this returns to the sign-in frame, whose verb performs auth.login',
};

/** 1p — sign out (review board only). */
export const SIGN_OUT: UnavailableReason = {
  cause: 'Sign-out isn’t connected here',
  remedy: 'this surface renders outside the auth gate and has no session to revoke — inside the gate the account menu’s sign-out performs auth.logout',
};

/**
 * 1h — redeem the invite (account + membership in one step).
 *
 * THE REMEDY CHANGED ON 2026-08-17 AND THE OLD ONE WOULD NOW MISLEAD. It said
 * "this gate does not call `spaces.invites.redeem` yet — the documented path
 * is the CLI", and the browser path now exists: a `/join/{code}` link is read
 * by `src/join/`, previewed with `auth.invite.resolve` and redeemed with
 * `spaces.invites.redeem`. Nobody should be sent to a terminal any more.
 *
 * This FRAME still cannot join, and that is now a property of the frame rather
 * than of the app: 1h draws the oracle's specimen values — a fixed inviter,
 * space and member count — and takes no code, no preview and no executor
 * (`FrameProps` has no slot for any of them). A button here would join on the
 * strength of facts nobody read. The live landing reads them first.
 */
export const REDEEM_INVITE: UnavailableReason = {
  cause: 'This preview card can’t join',
  remedy: 'its inviter, space and counts are the oracle’s specimen values and it takes no code — the live path is the /join/<code> landing, which reads auth.invite.resolve and performs spaces.invites.redeem',
};

/** 1k — resolve an endpoint. Phase 2, and D13 already refuses the affordance. */
export const CONNECT_ENDPOINT: UnavailableReason = {
  cause: 'Connecting to another server isn’t connected',
  remedy: 'remote servers arrive in Phase 2 (D13); no endpoint-resolve operation exists in the contract catalog',
};

/** 1l — authenticate against a resolved server. */
export const ADD_RESOLVED_SERVER: UnavailableReason = {
  cause: 'Adding this server isn’t connected',
  remedy: 'per-server auth arrives in Phase 2 (D13); neither the handshake nor the credential exchange has an operation here',
};

/** 1m — continue past the gateway to a hosted server. */
export const GATEWAY_CONTINUE: UnavailableReason = {
  cause: 'Gateway enumeration isn’t connected',
  remedy: 'Phase 2 (D13) — no operation resolves a gateway or lists the servers behind it',
};

/** 1n — retry a failed connection attempt. */
export const RETRY_CONNECT: UnavailableReason = {
  cause: 'Retry isn’t connected',
  remedy: 'there is no connect operation to retry — Phase 2 (D13)',
};

/** 1n — fall back to password after a refused token. */
export const CONNECT_USE_PASSWORD: UnavailableReason = {
  cause: 'Switching to password auth isn’t connected',
  remedy: 'per-server auth arrives in Phase 2 (D13); neither credential path has an operation on this frame',
};

/** 1n — the version-mismatch help link. */
export const UPDATE_INSTRUCTIONS: UnavailableReason = {
  cause: 'Update instructions aren’t wired',
  remedy: 'this build ships no update channel and no version-negotiation operation to have produced the mismatch',
};

/** 1p — profile editing. */
export const EDIT_PROFILE: UnavailableReason = {
  cause: 'Profile editing isn’t connected here',
  remedy: 'name and avatar are edited in Settings via the identity.profile.update operation; a password-change operation does not exist, and this modal is wired to neither',
};

/**
 * 1p — act as teammate. The ONE refusal the oracle itself draws: a "phase 2"
 * pill on a greyed row. Oracle and R7 agree exactly here, which is worth
 * saying out loud — it is the only frame where the design already anticipated
 * the treatment rather than the build imposing it.
 */
export const ACT_AS_TEAMMATE: UnavailableReason = {
  cause: 'Acting as a teammate arrives in Phase 2',
  remedy: 'IdentityView carries actingAs as a read; no operation sets it (the oracle draws this row disabled too)',
};

/** 1q — mint a new token. */
export const MINT_TOKEN: UnavailableReason = {
  cause: 'Minting a token isn’t connected',
  remedy: 'no access-token operation exists in the contract catalog — auth.login mints session passes, and nothing here can create a standing token or reveal one once',
};

/** 1q — revoke a token. */
export const REVOKE_TOKEN: UnavailableReason = {
  cause: 'Revoking a token isn’t connected',
  remedy: 'no access-token listing operation exists in the contract catalog, so nothing here can be enumerated or revoked (auth.logout revokes only the presented session)',
};

/** 1q — copy the one-time secret. */
export const COPY_TOKEN: UnavailableReason = {
  cause: 'There is no token to copy',
  remedy: 'no access-token operation exists in the contract catalog — the value beside this control is a specimen, not a secret',
};

/**
 * 1o — the server-grouped rail. NOT a seam gap: a LANE boundary. The rail is
 * `src/shell/MenuRail.tsx`, another seat's file, and rebuilding a static
 * replica of it here would be duplication that rots. The frame's own
 * contribution (the success toast) IS built; the rail behind it is flagged.
 */
export const SERVER_GROUPED_RAIL: UnavailableReason = {
  cause: 'The server-grouped rail is not built here',
  remedy: 'the rail is shell/MenuRail.tsx and its Phase-2 server grouping is that seat’s work — this frame builds only its own toast',
};

/** Every reason above, for the sweep tests and the handover's GAPS table. */
export const ALL_AUTH_REASONS: readonly UnavailableReason[] = [
  CLAIM_TOKEN_REQUIRED,
  CREATE_OWNER,
  NAME_SERVER,
  CREATE_SPACE,
  SIGN_IN_PASSWORD,
  SIGN_IN_OAUTH,
  FORGOT_PASSWORD,
  SIGN_IN_TOKEN,
  SIGN_IN_RETRY,
  REAUTH,
  SWITCH_ACCOUNT,
  SIGN_BACK_IN,
  SIGN_OUT,
  REDEEM_INVITE,
  CONNECT_ENDPOINT,
  ADD_RESOLVED_SERVER,
  GATEWAY_CONTINUE,
  RETRY_CONNECT,
  CONNECT_USE_PASSWORD,
  UPDATE_INSTRUCTIONS,
  EDIT_PROFILE,
  ACT_AS_TEAMMATE,
  MINT_TOKEN,
  REVOKE_TOKEN,
  COPY_TOKEN,
  SERVER_GROUPED_RAIL,
];
