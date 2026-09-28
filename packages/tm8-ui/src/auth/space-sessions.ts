/**
 * PINNED SPACE SESSIONS — the browser half of W3 (plan 01a0d9eb §3, matrix
 * T8c).
 *
 * Under `TM8_SPACE_SESSIONS=enforce` the pass `auth.login` returns is a GATE
 * session: it may list spaces, manage itself, do node admin and call
 * `auth.space.enter`, and nothing else. Every other call needs a session
 * pinned to the space it acts in. This module mints one on every space switch
 * and hands the transport the right credential per operation.
 *
 * UNDER `agents` NOTHING HERE ACTS (acceptance a4). A server is treated as
 * enforcing once `identity.get` advertises `spaceSessions: 'enforce'`, or
 * once it has refused a gate session (a node that predates the field), and
 * that fact is remembered per origin (`noteSpaceSessionsEnforced`). An
 * advertised `agents` or `off` forgets it. A node that never enforces never
 * gets an `auth.space.enter`, so its requests go out exactly as they did
 * before: the gate pass, cookies included.
 *
 * THE PINNED TOKENS LIVE IN MEMORY ONLY. They are re-minted from the gate pass
 * on the next switch or reload, so nothing new is written to storage. The
 * persisted marker is a fact about a server, not a credential.
 *
 * WHY `omitCookie`. `auth.space.enter` replaces the browser's session cookie
 * with the pinned session, so the WebSocket follows the space. From then on,
 * a different token in `Authorization` next to that cookie is refused as a
 * pair (identity-resolver), which would take down `spaces.list` (the gate
 * token) and any request racing a switch. Once a server enforces, every
 * bearer request therefore goes out without cookies, and the header alone
 * names the principal. `auth.space.enter` is the exception: its response is
 * what sets the cookie, and a browser ignores `Set-Cookie` on an omitted-
 * credentials request.
 *
 * WHAT THIS DOES NOT COVER. The loopback auto-owner (no pass, no session row,
 * not gated server-side) is untouched. A named server's pinned session rides
 * the relay in `Authorization` like its pass does.
 */
import { CollabError, type AuthSpaceEnterResult, type OperationName } from '@tm8/contract';

import { createHttpClient, type SpaceSessionPort } from '../data/real/http';
import { routeBaseUrlFor } from '../servers/server-key';
import {
  forgetSpaceSessionsEnforced,
  noteSpaceSessionsEnforced,
  passKeyFor,
  readServerPass,
  readSpaceSessionsEnforced,
} from './pass-store';

/**
 * What a gate session may call under enforce — mirrored from the server's
 * `gateSessionMayCall` (packages/server/src/http/space-gate.ts). These keep
 * the gate pass even inside a space: `spaces.list` under a pinned session
 * would list only the pinned space, and a pinned session never holds node
 * admin (K6).
 */
const GATE_SPACE_ENTRY_OPS: ReadonlySet<string> = new Set([
  'identity.get',
  'spaces.list',
  'spaces.create',
  'spaces.invites.redeem',
]);
const GATE_PREFIXES: readonly string[] = ['auth.', 'node.', 'serverConnections.'];

export function isGateOperation(op: OperationName | undefined): boolean {
  if (op === undefined) return false;
  if (GATE_SPACE_ENTRY_OPS.has(op)) return true;
  return GATE_PREFIXES.some((prefix) => op.startsWith(prefix));
}

/** The enforce gate's refusal (`assertSpaceGate`): forbidden, naming the fix. */
export function isSpaceGateRefusal(error: unknown): boolean {
  return (
    error instanceof CollabError &&
    error.code === 'forbidden' &&
    error.message.includes('auth.space.enter')
  );
}

interface PinnedSession {
  token: string;
  sessionId: string;
  /** The gate session it was minted from; a new sign-in orphans it. */
  parentSessionId: string;
  expiresAt: string;
}

/** Keyed `${originKey}\u0000${spaceId}`, the same origin key as the pass. */
const pinned = new Map<string, PinnedSession>();
/** serverId → the space the UI has selected on it. */
const activeSpaces = new Map<string, string>();
/** In-flight mints, so a switch and a recovery share one `auth.space.enter`. */
const entering = new Map<string, Promise<PinnedSession | null>>();

function pinKey(serverId: string, spaceId: string): string {
  return `${passKeyFor(serverId)}\u0000${spaceId}`;
}

function currentPin(serverId: string, spaceId: string): PinnedSession | null {
  const gate = readServerPass(serverId);
  const pin = pinned.get(pinKey(serverId, spaceId));
  if (!gate || !pin) return null;
  if (pin.parentSessionId !== gate.sessionId) return null;
  if (Date.parse(pin.expiresAt) <= Date.now()) return null;
  return pin;
}

/** Fire-and-forget revoke of one pinned session, presenting only itself. */
function revokePin(serverId: string, pin: PinnedSession): void {
  const client = createHttpClient({
    baseUrl: routeBaseUrlFor(serverId),
    fetch: (url, init) => globalThis.fetch(url, init),
    spaceSession: {
      credentialFor: () => ({ token: pin.token, omitCookie: true }),
      recover: async () => false,
    },
  });
  void client.call('auth.logout', { body: {} }).catch(() => {
    // A lost revoke expires with its gate session (capped server-side).
  });
}

/** W5: `auth.space.enter` refused for a missing or wrong space password. */
export function isSpacePasswordRefusal(error: unknown): boolean {
  if (!(error instanceof CollabError) || error.code !== 'forbidden') return false;
  const reason = error.details?.reason;
  return reason === 'space_password_required' || reason === 'space_password_rejected';
}

/**
 * Asks the viewer for a space's password; null means they declined. The
 * default is a masked native dialog; tests (and a future app-level modal)
 * replace it.
 */
export type SpacePasswordPrompter = (spaceId: string, rejected: boolean) => Promise<string | null>;

const MAX_SPACE_PASSWORD_ATTEMPTS = 3;

function defaultSpacePasswordPrompter(spaceId: string, rejected: boolean): Promise<string | null> {
  if (typeof document === 'undefined' || typeof HTMLDialogElement === 'undefined') {
    return Promise.resolve(null);
  }
  return new Promise((resolve) => {
    const dialog = document.createElement('dialog');
    const form = document.createElement('form');
    form.method = 'dialog';
    const label = document.createElement('label');
    label.textContent = rejected
      ? 'Space password not accepted. Try again:'
      : 'This space needs its space password:';
    const input = document.createElement('input');
    input.type = 'password';
    input.autocomplete = 'current-password';
    input.setAttribute('aria-label', `Space password for ${spaceId}`);
    const ok = document.createElement('button');
    ok.type = 'submit';
    ok.value = 'ok';
    ok.textContent = 'Enter space';
    const cancel = document.createElement('button');
    cancel.type = 'submit';
    cancel.value = 'cancel';
    cancel.textContent = 'Cancel';
    label.append(input);
    form.append(label, ok, cancel);
    dialog.append(form);
    dialog.addEventListener('close', () => {
      const value = dialog.returnValue === 'ok' && input.value ? input.value : null;
      input.value = '';
      dialog.remove();
      resolve(value);
    });
    document.body.append(dialog);
    dialog.showModal();
  });
}

let spacePasswordPrompter: SpacePasswordPrompter = defaultSpacePasswordPrompter;

/** Replace the space-password prompt; returns the previous one. */
export function setSpacePasswordPrompter(next: SpacePasswordPrompter): SpacePasswordPrompter {
  const previous = spacePasswordPrompter;
  spacePasswordPrompter = next;
  return previous;
}

/**
 * `auth.space.enter`, asking for the space password when the space refuses
 * without one. The password goes in the request body only; nothing keeps it.
 */
async function enterWithSpacePassword(
  client: ReturnType<typeof createHttpClient>,
  spaceId: string,
): Promise<AuthSpaceEnterResult> {
  let spacePassword: string | undefined;
  for (let attempt = 0; ; attempt += 1) {
    try {
      return await client.call<AuthSpaceEnterResult>('auth.space.enter', {
        body: { spaceId, label: 'tm8 web', ...(spacePassword ? { spacePassword } : {}) },
      });
    } catch (error) {
      if (!isSpacePasswordRefusal(error) || attempt >= MAX_SPACE_PASSWORD_ATTEMPTS) throw error;
      const next = await spacePasswordPrompter(spaceId, spacePassword !== undefined);
      if (!next) throw error;
      spacePassword = next;
    }
  }
}

async function mint(serverId: string, spaceId: string): Promise<PinnedSession | null> {
  const gate = readServerPass(serverId);
  if (!gate) return null;
  // No port on this client: the request carries the gate pass AND the cookie,
  // so the response's Set-Cookie lands. The server lets an explicit
  // Authorization beat the cookie on exactly this operation.
  const client = createHttpClient({
    baseUrl: routeBaseUrlFor(serverId),
    fetch: (url, init) => globalThis.fetch(url, init),
    getAuthToken: () => gate.token,
  });
  const result = await enterWithSpacePassword(client, spaceId);
  const next: PinnedSession = {
    token: result.token,
    sessionId: result.session.sessionId,
    parentSessionId: gate.sessionId,
    expiresAt: result.session.expiresAt,
  };
  // Signed out (or in as someone else) while the mint was in flight: the new
  // session belongs to nobody on this page. Revoke it rather than keep it.
  if (readServerPass(serverId)?.sessionId !== gate.sessionId) {
    revokePin(serverId, next);
    return null;
  }
  const key = pinKey(serverId, spaceId);
  const previous = pinned.get(key);
  pinned.set(key, next);
  if (previous) revokePin(serverId, previous);
  return next;
}

function enter(serverId: string, spaceId: string): Promise<PinnedSession | null> {
  const key = pinKey(serverId, spaceId);
  const inFlight = entering.get(key);
  if (inFlight) return inFlight;
  const run = mint(serverId, spaceId).finally(() => entering.delete(key));
  entering.set(key, run);
  return run;
}

export interface SpaceSessionHandle extends SpaceSessionPort {
  /**
   * The UI switched to `spaceId`. On an enforcing server this mints the
   * pinned session (`auth.space.enter`) before resolving; elsewhere it only
   * records the selection.
   */
  enterSpace(spaceId: string): Promise<void>;
  /** The token a non-catalog request (PTY grant, clipboard) should present. */
  requestToken(): string | null;
}

const handles = new Map<string, SpaceSessionHandle>();

/** One handle per server id, shared by every transport that reaches it. */
export function spaceSessionFor(serverId: string): SpaceSessionHandle {
  const existing = handles.get(serverId);
  if (existing) return existing;

  const enforced = () => readSpaceSessionsEnforced(serverId);

  const handle: SpaceSessionHandle = {
    credentialFor(op) {
      const gate = readServerPass(serverId);
      if (!gate || !enforced()) return null;
      // The response to this one sets the cookie; see the module comment.
      if (op === 'auth.space.enter') return null;
      if (isGateOperation(op)) return { token: gate.token, omitCookie: true };
      const space = activeSpaces.get(serverId);
      const pin = space ? currentPin(serverId, space) : null;
      // No pin yet: send the gate pass without the cookie, take the gate's
      // refusal, and let `recover` mint.
      return { token: pin?.token ?? gate.token, omitCookie: true };
    },

    async recover(error, op) {
      if (isGateOperation(op)) return false;
      const gate = readServerPass(serverId);
      const space = activeSpaces.get(serverId);
      if (!gate || !space) return false;
      if (isSpaceGateRefusal(error)) {
        noteSpaceSessionsEnforced(serverId);
      } else if (error.code === 'unauthenticated' && enforced() && currentPin(serverId, space)) {
        // The pinned session died (revoked, or expired early). The gate pass
        // is still the viewer's; mint a replacement rather than sign them out.
        pinned.delete(pinKey(serverId, space));
      } else {
        return false;
      }
      return (await enter(serverId, space)) !== null;
    },

    async enterSpace(spaceId) {
      activeSpaces.set(serverId, spaceId);
      if (!readServerPass(serverId) || !enforced()) return;
      await enter(serverId, spaceId);
    },

    requestToken() {
      return handle.credentialFor(undefined)?.token ?? readServerPass(serverId)?.token ?? null;
    },

    advertised(mode) {
      if (mode === 'enforce') noteSpaceSessionsEnforced(serverId);
      else if (mode === 'agents' || mode === 'off') forgetSpaceSessionsEnforced(serverId);
      // Absent: a node that predates the field; the 403 still teaches us.
    },
  };
  handles.set(serverId, handle);
  return handle;
}

/**
 * Sign-out: revoke every pinned session minted on `serverId` and forget them.
 * Called BEFORE the gate pass is cleared, so a pin's parent still matches.
 */
export function endSpaceSessions(serverId: string): void {
  const prefix = `${passKeyFor(serverId)}\u0000`;
  for (const [key, pin] of [...pinned]) {
    if (!key.startsWith(prefix)) continue;
    pinned.delete(key);
    revokePin(serverId, pin);
  }
  activeSpaces.delete(serverId);
}

/** Test affordance: forget every pinned session and handle, revoking nothing. */
export function resetSpaceSessions(): void {
  pinned.clear();
  activeSpaces.clear();
  entering.clear();
  handles.clear();
}
