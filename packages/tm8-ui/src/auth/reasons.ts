/**
 * THE GAP LEDGER, IN CODE.
 *
 * Every terminal act the T3 oracle draws, and the exact reason this build
 * cannot perform it. One file so the set is auditable in one read — a refusal
 * scattered across seventeen frames is a refusal nobody can count.
 *
 * THE MEASUREMENT BEHIND ALL OF THEM (`src/data/seam.ts`, read 2026-07-29):
 * the seam's ENTIRE identity surface is `identity(): Promise<IdentityView>` —
 * one read. `seam.commands` carries 18 verbs; not one of them is an auth verb.
 * There is no signIn, no signOut, no createAccount, no createSpace, no
 * redeemInvite, no token mint/list/revoke, no addServer. Two of these DO exist
 * as v1 operations in `packages/contract/src/catalog.ts` (`spaces.create`,
 * `spaces.invites.redeem`) and are simply not exposed through the seam — those
 * two say so, because "the server cannot" and "our seam does not carry it" are
 * different facts and a reader can act on the difference.
 *
 * VOICE (T1-4, quoted from the canvas footer): "exact reason + consequence",
 * reasons name the thing that is missing so they read as fact, not apology.
 * `auth.test.tsx` asserts no reason here says "coming soon" and that every one
 * names a seam/contract/operation/phase — the copy is under test because the
 * copy IS the honesty.
 */
import type { UnavailableReason } from '../panels/honesty/DisabledWithReason';

/**
 * THE MISSING OPERATIONS, NAMED. Flagged to the program lead as
 * additive-amendment candidates, so these are the names the UI would call —
 * stated here so the ask and the code agree, and so a reader can grep for
 * them when they land.
 *
 *   auth.signup       POST /v2/auth/signup    → create an account, return a session
 *   auth.login        POST /v2/auth/login     → handle+password (or token) → session
 *   auth.logout       POST /v2/auth/logout    → revoke the presented session
 *   auth.session.get  GET  /v2/auth/session   → is this session still valid, and whose
 *
 * With those four the gate stops being local: `createLocalAccount` becomes
 * `auth.signup`, `signInLocal` becomes `auth.login`, `signOutLocal` becomes
 * `auth.logout`, and the reload check becomes `auth.session.get` instead of a
 * localStorage read. Nothing else in this module has to move.
 */
export const MISSING_AUTH_OPS = [
  'auth.signup',
  'auth.login',
  'auth.logout',
  'auth.session.get',
] as const;

/** 1a — create the owner account. */
export const CREATE_OWNER: UnavailableReason = {
  cause: 'Creating a server account isn’t connected',
  remedy: 'the node exposes identity.get and no auth operation — auth.signup does not exist, so this can only ever create the LOCAL account the gate uses',
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
  remedy: 'spaces.create is a v1 contract op the stamped seam does not expose (same gap D13 rules for the tab bar’s ＋)',
};

/** 1d — sign in with a handle and password. */
export const SIGN_IN_PASSWORD: UnavailableReason = {
  cause: 'Server sign-in isn’t connected',
  remedy: 'auth.login does not exist on this node; the gate verifies against the local account instead, and says so where it does',
};

/** 1d — sign in with an access token. */
export const SIGN_IN_TOKEN: UnavailableReason = {
  cause: 'Token sign-in isn’t connected',
  remedy: 'no token operation exists in the contract catalog and auth.login does not either — nothing can mint, present or verify one, in the gate or out of it',
};

/** 1e — retry after a failed sign-in. */
export const SIGN_IN_RETRY: UnavailableReason = {
  cause: 'Retrying sign-in isn’t connected',
  remedy: 'auth.login does not exist, so there is no server attempt to retry — and nothing enforces the attempt counter this card draws',
};

/** 1f — re-authenticate in place after expiry. */
export const REAUTH: UnavailableReason = {
  cause: 'Re-authenticating isn’t connected',
  remedy: 'auth.login and auth.session.get do not exist, and no expiry signal reaches the UI — nothing in this build can tell you a session ended',
};

/** 1f — sign in as someone else, which drops the kept view. */
export const SWITCH_ACCOUNT: UnavailableReason = {
  cause: 'Switching accounts isn’t connected',
  remedy: 'the seam has no sign-in verb; there is no second identity to switch to',
};

/** 1g — sign back in from the signed-out landing. */
export const SIGN_BACK_IN: UnavailableReason = {
  cause: 'Signing back in isn’t connected here',
  remedy: 'auth.login does not exist; inside the gate this returns to the sign-in frame, which verifies against the local account',
};

/** 1p — sign out. */
export const SIGN_OUT: UnavailableReason = {
  cause: 'Server sign-out isn’t connected',
  remedy: 'auth.logout does not exist; inside the gate this row clears the LOCAL session, which is a different act and says so',
};

/** 1h — redeem the invite (account + membership in one step). */
export const REDEEM_INVITE: UnavailableReason = {
  cause: 'Redeeming this invite isn’t connected',
  remedy: 'spaces.invites.redeem is a v1 contract op the seam does not expose, and no operation reads an invite before you join',
};

/** 1k — resolve an endpoint. Phase 2, and D13 already refuses the affordance. */
export const CONNECT_ENDPOINT: UnavailableReason = {
  cause: 'Connecting to another server isn’t connected',
  remedy: 'remote servers arrive in Phase 2 (D13); no endpoint-resolve operation exists in the contract catalog',
};

/** 1l — authenticate against a resolved server. */
export const ADD_RESOLVED_SERVER: UnavailableReason = {
  cause: 'Adding this server isn’t connected',
  remedy: 'per-server auth arrives in Phase 2 (D13); neither the handshake nor the credential exchange has an operation',
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
  remedy: 'per-server auth arrives in Phase 2 (D13); neither credential path has an operation',
};

/** 1n — the version-mismatch help link. */
export const UPDATE_INSTRUCTIONS: UnavailableReason = {
  cause: 'Update instructions aren’t wired',
  remedy: 'this build ships no update channel and no version-negotiation operation to have produced the mismatch',
};

/** 1p — profile editing. */
export const EDIT_PROFILE: UnavailableReason = {
  cause: 'Profile editing isn’t connected',
  remedy: 'no account operation exists in the contract catalog — name, avatar and password have nowhere to be written',
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
  remedy: 'no token operation exists in the contract catalog — nothing to create, and nothing to reveal once',
};

/** 1q — revoke a token. */
export const REVOKE_TOKEN: UnavailableReason = {
  cause: 'Revoking a token isn’t connected',
  remedy: 'no token operation exists in the contract catalog, so nothing here can be revoked',
};

/** 1q — copy the one-time secret. */
export const COPY_TOKEN: UnavailableReason = {
  cause: 'There is no token to copy',
  remedy: 'no token operation exists in the contract catalog — the value beside this control is a specimen, not a secret',
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
  CREATE_OWNER,
  NAME_SERVER,
  CREATE_SPACE,
  SIGN_IN_PASSWORD,
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
