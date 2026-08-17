/**
 * THE JOIN LINK — how the code in an invite URL survives long enough to be redeemed.
 *
 * WHAT WAS BROKEN. `settings-space/InviteFrames.tsx:joinUrlFor` has been
 * handing admins `${origin}/join/{code}` to send to people, and NOTHING ON THE
 * RECEIVING END READ IT. `routes/` has no join grammar: `redirect()` rewrites
 * the unknown head onto the last-active space and `parseTarget` falls through
 * to `{view:'home'}` (`codec.ts:344`), so the code was discarded in silence and
 * the recipient landed on somebody else's home screen. `auth/reasons.ts` sent
 * them to the CLI instead. A link that silently does nothing is worse than one
 * that fails, and this is the module that stops it.
 *
 * WHY NOT IN `routes/`. That router's first act is to require `#/s/{spaceId}`
 * (`codec.ts:201`), and a join link is the one URL whose entire purpose is that
 * you have no space yet — learning which one is what redeeming is FOR.
 * Teaching the space router a space-less route would invert its precondition
 * for a single case. This is parsed before that router ever runs.
 *
 * PATH FIRST, HASH ACCEPTED. `joinUrlFor` emits a PATH, and that works because
 * the node's static handler falls back to `index.html` for extension-less
 * paths (`server/src/http/static.ts`) — so `/join/{code}` boots the app with
 * the code in `location.pathname`. The hash spelling is accepted too, because
 * a static host without that rewrite is a real deployment and `#/join/{code}`
 * is what still works there.
 *
 * WHY THE CODE IS PARKED. Redeeming requires an identity (`redeem_invite`
 * opens with `internal.require_identity()`, migration 118), and the person
 * following an invite is usually signed out. `AuthGate` renders the sign-in
 * flow INSTEAD of its children, so a code held only in React state dies at
 * exactly the moment it is needed. It is parked the moment it is seen.
 *
 * WHY sessionStorage. A code is a credential — the database treats it as one
 * (RLS admits only space admins to `space_invites`, and the command ledger
 * strips the live code from recorded invite commands). It must outlive a
 * re-render and a sign-in; it must NOT outlive the tab or sit on disk for the
 * next person at this machine. That lifetime is `sessionStorage` exactly.
 *
 * WHY THE URL IS STRIPPED once parked. Same reason: a credential should not
 * stay in the address bar, a screen share, or a screenshot for the session.
 */

/** Where a parked code lives. Namespaced like every other key this app sets. */
export const PENDING_JOIN_KEY = 'tm8ui.join.pending';

/** `/join/{code}` — the path `joinUrlFor` produces. */
const PATH_PATTERN = /^\/join\/([^/?#]+)\/?$/;
/** `#/join/{code}` — the hash spelling, for hosts with no SPA rewrite. */
const HASH_PATTERN = /^#?\/join\/([^/?#]+)/;

function decode(raw: string | undefined): string | null {
  if (raw === undefined) return null;
  let code: string;
  try {
    code = decodeURIComponent(raw);
  } catch {
    // A malformed escape sequence is not a code.
    return null;
  }
  code = code.trim();
  // Length-capped so a hostile link cannot park a megabyte; NOT format-checked
  // beyond that, because the node is the authority on what a real code looks
  // like and a client-side guess would reject codes a later server mints.
  if (code.length === 0 || code.length > 200) return null;
  return code;
}

/** The code carried by a location, from either spelling, or `null`. */
export function readJoinCode(pathname: string, hash: string): string | null {
  return decode(PATH_PATTERN.exec(pathname)?.[1]) ?? decode(HASH_PATTERN.exec(hash)?.[1]);
}

function store(): Storage | null {
  // Absent under a non-browser test env, and THROWS on access in a browser
  // with site data blocked. Both mean "no parking space", which must not take
  // the app down — the journey degrades to redeem-in-this-render.
  try {
    return typeof sessionStorage === 'undefined' ? null : sessionStorage;
  } catch {
    return null;
  }
}

/**
 * Park a code seen in the URL, and take it out of the address bar.
 *
 * Safe on every boot: with no code in the URL it touches nothing and returns
 * whatever is already parked — which is the point, since the URL stopped
 * carrying it precisely because this function parked it.
 */
export function capturePendingJoin(): string | null {
  const s = store();
  const fromUrl =
    typeof location === 'undefined' ? null : readJoinCode(location.pathname, location.hash);

  if (fromUrl !== null) {
    try {
      s?.setItem(PENDING_JOIN_KEY, fromUrl);
    } catch {
      // Quota, or a disabled store. The code is still returned and the journey
      // continues in this render; only surviving a reload is lost.
    }
    try {
      // `replaceState`, not an assignment: pushing would leave the URL that
      // still holds the code one Back press away.
      history.replaceState(null, '', '/');
    } catch {
      /* a sandboxed frame can refuse this; the code is parked either way */
    }
    return fromUrl;
  }

  try {
    return s?.getItem(PENDING_JOIN_KEY) ?? null;
  } catch {
    return null;
  }
}

/** Read without side effects, for callers that must not strip the URL. */
export function peekPendingJoin(): string | null {
  try {
    return store()?.getItem(PENDING_JOIN_KEY) ?? null;
  } catch {
    return null;
  }
}

/**
 * Forget the parked code — on success AND on every dismissal. A code somebody
 * walked away from must not ambush them on their next boot.
 */
export function clearPendingJoin(): void {
  try {
    store()?.removeItem(PENDING_JOIN_KEY);
  } catch {
    /* nothing to clear if the store is unreachable */
  }
}

/**
 * A code, shown as its ends only.
 *
 * The node mints `inv_` + 32 hex characters: unreadable in full and a secret
 * besides. The ends are enough to tell two codes apart, which is all a screen
 * ever needs — the whole value belongs in the clipboard, not on the display.
 */
export function maskCode(code: string): string {
  return code.length <= 14 ? code : `${code.slice(0, 8)}…${code.slice(-4)}`;
}

let joinSeq = 0;

/**
 * A fresh idempotency key per redeem ATTEMPT.
 *
 * It must not be stable across attempts. The node replays a stored result for
 * a repeated `clientMutationId` (`internal.ledger_replay`, 118), so reusing one
 * would make a retry answer out of the ledger instead of touching the invite —
 * right for a double-click on one attempt, wrong for "that failed, trying
 * again".
 */
export function newJoinMutationId(): string {
  joinSeq += 1;
  return `join_redeem_${joinSeq.toString(36)}_${Date.now().toString(36)}`;
}
