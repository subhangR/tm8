/**
 * Legacy redirect table (LLD §6, SPEC-FINAL §4.2.5 — the COMPLETE table).
 *
 * Space is always preserved. Bare legacy forms (`#/tasks`) resolve against the
 * last-active space; with no last-active space there is nothing to redirect TO,
 * so the caller renders the space picker.
 *
 * `graph` and `leaderboard` are R7-deferred features: they land on `home` and
 * report the deferral so the NoticeHost can say so honestly, rather than
 * 404-ing or silently swallowing the intent.
 */
import type { SpaceId } from '@tm8/contract';

export type DeferredFeature = 'graph' | 'leaderboard';

export interface RedirectOutcome {
  hash: string;
  /** Set when the legacy route addressed an R7-deferred feature. */
  deferredFeature?: DeferredFeature;
}

/** Legacy first segment → the new path tail. */
const SIMPLE: Readonly<Record<string, string>> = {
  tasks: 'k/tasks',
  sessions: 'k/sessions',
  docs: 'k/docs',
  team: 'k/teammates',
  tracking: 'k/pulls',
};

const DEFERRED: Readonly<Record<string, DeferredFeature>> = {
  graph: 'graph',
  leaderboard: 'leaderboard',
};

function split(hash: string): { segments: string[]; query: string } {
  const raw = hash.replace(/^#/, '');
  const at = raw.indexOf('?');
  const path = at === -1 ? raw : raw.slice(0, at);
  return {
    segments: path.split('/').filter((s) => s.length > 0),
    query: at === -1 ? '' : raw.slice(at + 1),
  };
}

function withQuery(path: string, query: string, extra?: string): string {
  const parts = [query, extra].filter((part): part is string => Boolean(part));
  return parts.length ? `${path}?${parts.join('&')}` : path;
}

/**
 * Returns the redirected hash, or `null` when the hash is already canonical
 * (or unresolvable, e.g. a bare legacy form with no last-active space).
 */
export function redirect(
  hash: string,
  opts: { lastActiveSpaceId?: SpaceId | null } = {},
): RedirectOutcome | null {
  const { segments, query } = split(hash);

  let spaceId: SpaceId | null;
  let rest: string[];
  if (segments[0] === 's' && segments[1]) {
    spaceId = segments[1];
    rest = segments.slice(2);
  } else {
    // Bare legacy form: resolve against the last-active space, else give up
    // and let the caller render the space picker.
    spaceId = opts.lastActiveSpaceId ?? null;
    rest = segments;
  }
  if (rest.length === 0) return null;

  const head = rest[0];

  if (head in DEFERRED) {
    if (!spaceId) return null;
    return { hash: withQuery(`#/s/${spaceId}/home`, query), deferredFeature: DEFERRED[head] };
  }

  // `#/s/{s}/sessions/{id}` → `#/s/{s}/e/{id}?origin=sessions`. Checked before
  // the bare `sessions` row: the ID-bearing form is a different destination.
  if (head === 'sessions' && rest[1]) {
    if (!spaceId) return null;
    return { hash: withQuery(`#/s/${spaceId}/e/${rest[1]}`, query, 'origin=sessions') };
  }

  if (head in SIMPLE) {
    if (!spaceId) return null;
    const tail = [SIMPLE[head], ...rest.slice(1)].join('/');
    return { hash: withQuery(`#/s/${spaceId}/${tail}`, query) };
  }

  // Everything else — home, feed, inbox, settings, workspace, channels,
  // channel/{id}, k/{slug}, e/{id} — is already canonical. A bare canonical
  // form still needs its space stitched on.
  if (segments[0] !== 's' && spaceId) {
    return { hash: withQuery(`#/s/${spaceId}/${rest.join('/')}`, query) };
  }
  return null;
}
