/**
 * THE ROUTE CODEC — parse / build / normalize (LLD §6, WLT §2.2).
 *
 * Three pure functions, no store, no window. Written FRESH: `buildHash` from
 * the old shell is condemned and is not consulted (SPEC-FINAL C-7).
 *
 * Laws implemented here, each with a test:
 *   - grammar verbatim (WLT §2.2);
 *   - `p` / `pin` / `t` / `contentSurface` encodings (SPEC-FINAL §4.2.2);
 *   - total cap 2048 with ordered ATOMIC drops: the `t` tier (`t` AND
 *     `contentSurface` together) → `pin` → `p` → `q`;
 *   - unparseable param ⇒ atomic discard, canonical default renders;
 *   - hydration dedup pin > stack;
 *   - D12 preserve-and-clamp: `contentSurface={id}:chat` is VALID grammar —
 *     the codec accepts it, preserves it, and round-trips it unchanged.
 *     Clamping to terminal is a PRESENTATION decision made elsewhere; the URL
 *     is never rewritten, because a Phase-2 deep link authored today must not
 *     be made lossy by a Phase-1 client.
 */
import type { EntityId, SpaceId } from '@tm8/contract';
import { ALL_MODES, kindBySlug } from '../domain';
import type { CollectionMode } from '../domain';
import { decodeQ, encodeQ } from './q';
import type {
  BuildOutcome,
  ContentSurface,
  DropClass,
  NavView,
  Origin,
  PanelState,
  ParseOutcome,
  PanelTab,
  QValue,
  Route,
} from './types';
import { CONTENT_SURFACES, MAX_HASH_LENGTH, PANEL_TABS, emptyPanels } from './types';

// ---------------------------------------------------------------------------
// Percent-encoding (RFC 3986)
// ---------------------------------------------------------------------------

/**
 * `encodeURIComponent` leaves `.` unescaped, and `.` is the `p`/`pin`/`origin`
 * delimiter — so it is escaped explicitly. `:` and `,` (the `t` delimiters)
 * are already escaped by `encodeURIComponent`.
 */
function enc(value: string): string {
  return encodeURIComponent(value).replace(/\./g, '%2E');
}

function dec(value: string): string | null {
  try {
    return decodeURIComponent(value);
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// parse
// ---------------------------------------------------------------------------

const MODES = new Set<string>(ALL_MODES);
const TABS = new Set<string>(PANEL_TABS);
const SURFACES = new Set<string>(CONTENT_SURFACES);

/**
 * Query values are kept RAW here on purpose. `URLSearchParams` would decode
 * them once, and this codec's own sub-token decoding would then decode a
 * SECOND time — mangling any id that legitimately contains `%`, `.` or `:`.
 * Exactly one decode happens, and it happens on the sub-token.
 */
function parseQuery(raw: string): Map<string, string> {
  const out = new Map<string, string>();
  if (raw.length === 0) return out;
  for (const pair of raw.split('&')) {
    if (pair.length === 0) continue;
    const eq = pair.indexOf('=');
    const key = eq === -1 ? pair : pair.slice(0, eq);
    const value = eq === -1 ? '' : pair.slice(eq + 1);
    if (!out.has(key)) out.set(key, value);
  }
  return out;
}

interface Query {
  get(key: string): string | null;
}

function splitHash(hash: string): { segments: string[]; query: Query } {
  const withoutLead = hash.replace(/^#/, '');
  const queryAt = withoutLead.indexOf('?');
  const path = queryAt === -1 ? withoutLead : withoutLead.slice(0, queryAt);
  const rawQuery = queryAt === -1 ? '' : withoutLead.slice(queryAt + 1);
  const segments = path
    .split('/')
    .filter((segment) => segment.length > 0)
    .map((segment) => dec(segment) ?? '');
  const params = parseQuery(rawQuery);
  return { segments, query: { get: (key) => params.get(key) ?? null } };
}

/** Dot-joined id list. Any malformed member discards the WHOLE param. */
function parseIdList(raw: string | null, onDrop: () => void): EntityId[] {
  if (raw === null) return [];
  if (raw.length === 0) {
    onDrop();
    return [];
  }
  const out: EntityId[] = [];
  for (const token of raw.split('.')) {
    const id = dec(token);
    if (id === null || id.length === 0) {
      onDrop();
      return [];
    }
    out.push(id);
  }
  return out;
}

/** Comma-joined `{id}:{value}` pairs. Any malformed pair discards the WHOLE param. */
function parsePairs<T extends string>(
  raw: string | null,
  allowed: ReadonlySet<string>,
  onDrop: () => void,
): Record<EntityId, T> {
  if (raw === null) return {};
  if (raw.length === 0) {
    onDrop();
    return {};
  }
  const out: Record<EntityId, T> = {};
  for (const pair of raw.split(',')) {
    const colon = pair.lastIndexOf(':');
    if (colon <= 0) {
      onDrop();
      return {};
    }
    const id = dec(pair.slice(0, colon));
    const value = dec(pair.slice(colon + 1));
    if (id === null || value === null || id.length === 0 || !allowed.has(value)) {
      onDrop();
      return {};
    }
    out[id] = value as T;
  }
  return out;
}

function parseOrigin(raw: string | null, onDrop: () => void): Origin | null {
  if (raw === null) return null;
  const dot = raw.indexOf('.');
  const slug = dec(dot === -1 ? raw : raw.slice(0, dot)) ?? '';
  const modeRaw = dot === -1 ? null : raw.slice(dot + 1);
  // Registry-validated: a slug no row (and no `c-` custom kind) answers to is
  // not an origin we can honestly render a companion for.
  const known = kindBySlug(slug) !== null || (slug.startsWith('c-') && slug.length > 2);
  if (!known || slug.length === 0) {
    onDrop();
    return null;
  }
  if (modeRaw !== null && !MODES.has(modeRaw)) {
    onDrop();
    return null;
  }
  return { slug, mode: (modeRaw as CollectionMode | null) ?? null };
}

function parseMode(raw: string | null, onDrop: () => void): CollectionMode | null {
  if (raw === null) return null;
  if (!MODES.has(raw)) {
    onDrop();
    return null;
  }
  return raw as CollectionMode;
}

function parseQ(raw: string | null, onDrop: () => void): QValue | null {
  if (raw === null) return null;
  const value = decodeQ(raw);
  if (value === null) {
    onDrop();
    return null;
  }
  return value;
}

/**
 * Parse a hash into a route. Never throws and never returns a partially-read
 * param: anything unparseable is discarded ATOMICALLY and the canonical
 * default renders in its place.
 */
export function parse(hash: string): ParseOutcome {
  const dropped: DropClass[] = [];
  const drop = (cls: DropClass) => () => {
    if (!dropped.includes(cls)) dropped.push(cls);
  };

  const { segments, query } = splitHash(hash);
  if (segments[0] !== 's' || !segments[1]) {
    // No addressable space: the caller resolves last-active space or renders
    // the space picker.
    return { route: null, dropped };
  }
  const spaceId: SpaceId = segments[1];
  const rest = segments.slice(2);

  const panels: PanelState = {
    stack: parseIdList(query.get('p'), drop('stack')),
    pinned: parseIdList(query.get('pin'), drop('pins')),
    tabs: parsePairs<PanelTab>(query.get('t'), TABS, drop('tabs')),
    contentSurface: parsePairs<ContentSurface>(query.get('contentSurface'), SURFACES, drop('tabs')),
    session: null,
  };

  const sessionRaw = query.get('session');
  if (sessionRaw !== null) {
    const session = dec(sessionRaw);
    if (session === null || session.length === 0) drop('session')();
    else panels.session = session;
  }

  const target = parseTarget(rest, query, drop);
  return { route: { spaceId, target, panels }, dropped };
}

function parseTarget(
  rest: string[],
  query: Query,
  drop: (cls: DropClass) => () => void,
): NavView {
  const head = rest[0];
  switch (head) {
    case undefined:
    case 'home':
      return { view: 'home' };
    case 'feed':
      return { view: 'feed' };
    case 'inbox':
      return { view: 'inbox' };
    case 'workspace':
      return { view: 'workspace' };
    case 'channels':
      return { view: 'channels' };
    /* The 2026-08-14 amendment — four screens that had no route. Flat segments
       with no parameters of their own; each is a whole-centre screen (the D65
       posture) so there is no sub-state to encode beyond the shared panel
       params every route already carries. */
    case 'graph':
      return { view: 'graph' };
    case 'files':
      return { view: 'files' };
    case 'git':
      return { view: 'git' };
    case 'messages':
      return { view: 'messages' };
    case 'settings': {
      const section = rest[1];
      if (section === 'projects' || section === 'menu') return { view: 'settings', section };
      return { view: 'settings', section: null };
    }
    case 'channel': {
      const channelId = rest[1];
      if (!channelId) return { view: 'channels' };
      let msg: EntityId | null = null;
      const msgRaw = query.get('msg');
      if (msgRaw !== null) {
        const decoded = dec(msgRaw);
        if (decoded === null || decoded.length === 0) drop('anchor')();
        else msg = decoded;
      }
      return { view: 'channel', channelId, msg };
    }
    case 'k': {
      const slug = rest[1];
      if (!slug) return { view: 'home' };
      return {
        view: 'kind',
        slug,
        mode: parseMode(query.get('mode'), drop('mode')),
        q: parseQ(query.get('q'), drop('query')),
      };
    }
    case 'e': {
      const entityId = rest[1];
      if (!entityId) return { view: 'home' };
      return { view: 'entity', entityId, origin: parseOrigin(query.get('origin'), drop('origin')) };
    }
    default:
      // An unknown view segment is not a partial route: fall back to the
      // canonical default rather than rendering something half-addressed.
      return { view: 'home' };
  }
}

// ---------------------------------------------------------------------------
// build
// ---------------------------------------------------------------------------

function pathOf(route: Route): string {
  const base = `#/s/${enc(route.spaceId)}`;
  const t = route.target;
  switch (t.view) {
    case 'home':
      return `${base}/home`;
    case 'feed':
      return `${base}/feed`;
    case 'inbox':
      return `${base}/inbox`;
    case 'workspace':
      return `${base}/workspace`;
    case 'channels':
      return `${base}/channels`;
    case 'graph':
      return `${base}/graph`;
    case 'files':
      return `${base}/files`;
    case 'git':
      return `${base}/git`;
    case 'messages':
      return `${base}/messages`;
    case 'channel':
      return `${base}/channel/${enc(t.channelId)}`;
    case 'kind':
      return `${base}/k/${enc(t.slug)}`;
    case 'entity':
      return `${base}/e/${enc(t.entityId)}`;
    case 'settings':
      return t.section ? `${base}/settings/${t.section}` : `${base}/settings`;
  }
}

type Param = [key: string, value: string];

function idList(ids: readonly EntityId[]): string {
  return ids.map(enc).join('.');
}

function pairs(record: Readonly<Record<EntityId, string>>): string {
  return Object.entries(record)
    .map(([id, value]) => `${enc(id)}:${enc(value)}`)
    .join(',');
}

function serialize(path: string, params: readonly Param[]): string {
  if (params.length === 0) return path;
  return `${path}?${params.map(([k, v]) => `${k}=${v}`).join('&')}`;
}

/**
 * Serialize a route. Respects the total 2048-char cap by dropping WHOLE params
 * in the ruled order — never mid-token, never over cap. Navigation always
 * succeeds; the caller emits ONE generalized notice for `dropped`.
 */
export function build(route: Route): BuildOutcome {
  const path = pathOf(route);
  const t = route.target;

  const viewParams: Param[] = [];
  if (t.view === 'kind') {
    if (t.mode) viewParams.push(['mode', t.mode]);
  } else if (t.view === 'entity') {
    if (t.origin) {
      const value = t.origin.mode ? `${enc(t.origin.slug)}.${t.origin.mode}` : enc(t.origin.slug);
      viewParams.push(['origin', value]);
    }
  } else if (t.view === 'channel') {
    if (t.msg) viewParams.push(['msg', enc(t.msg)]);
  }
  if (route.panels.session) viewParams.push(['session', enc(route.panels.session)]);

  const qParam: Param[] = t.view === 'kind' && t.q ? [['q', encodeQ(t.q)]] : [];
  const stackParam: Param[] = route.panels.stack.length ? [['p', idList(route.panels.stack)]] : [];
  const pinParam: Param[] = route.panels.pinned.length ? [['pin', idList(route.panels.pinned)]] : [];
  const tabsParam: Param[] = [];
  if (Object.keys(route.panels.tabs).length) tabsParam.push(['t', pairs(route.panels.tabs)]);
  if (Object.keys(route.panels.contentSurface).length) {
    tabsParam.push(['contentSurface', pairs(route.panels.contentSurface)]);
  }

  // Drop tiers, most-droppable first. `t` and contentSurface go TOGETHER —
  // they are one tier, because surface state without tab state is a lie about
  // which panel the surface belongs to.
  const tiers: { cls: DropClass; params: Param[] }[] = [
    { cls: 'tabs', params: tabsParam },
    { cls: 'pins', params: pinParam },
    { cls: 'stack', params: stackParam },
    { cls: 'query', params: qParam },
  ];

  const dropped: DropClass[] = [];
  let live = tiers;
  for (;;) {
    const params = [...viewParams, ...live.flatMap((tier) => tier.params)];
    const hash = serialize(path, params);
    if (hash.length <= MAX_HASH_LENGTH || live.length === 0) return { hash, dropped };
    const [head, ...tail] = live;
    if (head.params.length > 0) dropped.push(head.cls);
    live = tail;
  }
}

// ---------------------------------------------------------------------------
// normalize
// ---------------------------------------------------------------------------

/**
 * The canonical form of a route. Idempotent by construction
 * (`normalize ∘ normalize = normalize`, asserted by property test):
 *
 *   - `p` and `pin` deduped within themselves (first occurrence wins);
 *   - CROSS-SET dedup with precedence PIN > STACK (WLT §2.2 hydration rule);
 *   - `t` / `contentSurface` entries for ids that are not open are pruned —
 *     they address panels that do not exist;
 *   - `t` entries equal to the default (`content`) are dropped, since an
 *     omitted pair already means `content`;
 *   - `contentSurface` values are NOT canonicalized: `terminal` is explicit
 *     state, and `chat` is PRESERVED (D12) — Phase-1 presentation clamps, the
 *     URL never lies about what the link asked for.
 *
 * Panel-count limits (MAX_PINNED, the C_min demotion loop) are deliberately
 * NOT enforced here: those need a measured centre width and belong to the
 * shell's geometry pass, which hands the settled result to the nav store.
 */
export function normalize(route: Route): Route {
  const pinned = dedupe(route.panels.pinned);
  const pinnedSet = new Set(pinned);
  const stack = dedupe(route.panels.stack).filter((id) => !pinnedSet.has(id));
  const open = new Set([...pinned, ...stack]);

  const tabs: Record<EntityId, PanelTab> = {};
  for (const [id, tab] of Object.entries(route.panels.tabs)) {
    if (open.has(id) && tab !== 'content') tabs[id] = tab;
  }

  const contentSurface: Record<EntityId, ContentSurface> = {};
  for (const [id, surface] of Object.entries(route.panels.contentSurface)) {
    if (open.has(id)) contentSurface[id] = surface;
  }

  return {
    spaceId: route.spaceId,
    target: route.target,
    panels: { stack, pinned, tabs, contentSurface, session: route.panels.session },
  };
}

function dedupe(ids: readonly EntityId[]): EntityId[] {
  const seen = new Set<EntityId>();
  const out: EntityId[] = [];
  for (const id of ids) {
    if (seen.has(id)) continue;
    seen.add(id);
    out.push(id);
  }
  return out;
}

/** A route with nothing open — the canonical default for a space. */
export function defaultRoute(spaceId: SpaceId, target: NavView = { view: 'home' }): Route {
  return { spaceId, target, panels: emptyPanels() };
}
