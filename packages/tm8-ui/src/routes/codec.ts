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
import type { EntityId, MenuViewRef, SpaceId } from '@tm8/contract';
import { ALL_MODES, VIEW_REF_ROUTE, kindBySlug } from '../domain';
import type { CollectionMode } from '../domain';
import { decodeQ, encodeQ } from './q';
import type {
  BuildOutcome,
  CockpitStage,
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
import {
  COCKPIT_STAGES,
  CONTENT_SURFACES,
  LEGACY_CONTENT_SURFACES,
  MAX_HASH_LENGTH,
  PANEL_TABS,
  SETTINGS_ROUTE_SECTIONS,
  emptyPanels,
} from './types';

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

/**
 * "Plausibly an entity id" for a query parameter that names one.
 *
 * DELIBERATELY LOOSE — this is a shape gate, not a validation. The route layer
 * cannot know whether an entity exists, and a strict uuid pattern would refuse
 * a legitimate id form the graph adopts later. It exists only so that a
 * pasted `?about=hello` does not travel into a composer as a subject.
 */
const ID_LIKE = /^[0-9a-zA-Z_-]{8,64}$/;

const MODES = new Set<string>(ALL_MODES);
const TABS = new Set<string>(PANEL_TABS);
// Retired tokens are ACCEPTED here and canonicalized below — see
// LEGACY_CONTENT_SURFACES for why a dead name still parses.
const SURFACES = new Set<string>([...CONTENT_SURFACES, ...Object.keys(LEGACY_CONTENT_SURFACES)]);

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
  /** Retired tokens mapped to their current spelling. Applied AFTER `allowed`,
   *  so an alias must also be a member of `allowed` to survive. */
  canonical: Readonly<Record<string, string>> = {},
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
    out[id] = (canonical[value] ?? value) as T;
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
  /* A `v-` value belongs to `parseOriginView`; returning null here without
     dropping keeps the two parsers from reporting the same parameter twice. */
  if (raw.startsWith('v-')) return null;
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

/**
 * `origin=v-{ref}` — the VIEW companion, told apart from a collection origin by
 * a prefix that cannot collide.
 *
 * WHY A PREFIX AND NOT A SECOND PARAMETER. One `origin=` carries one companion,
 * so an address can never name two, and the mutual exclusion is structural
 * rather than something a reader has to check. The `c-` custom-kind prefix is
 * the existing precedent for discriminating inside this value.
 *
 * `v-` CANNOT COLLIDE: a collection origin is a registry slug or a `c-` custom
 * kind, and no kind's slug begins `v-`. `kindBySlug` is consulted first for the
 * unprefixed form, so the two parsers never see each other's input.
 *
 * REGISTRY-VALIDATED LIKE ITS SIBLING. `VIEW_REF_ROUTE` is `Record<MenuViewRef,
 * …>`, so a ref no view answers to is dropped rather than carried — the same
 * honesty `parseOrigin` applies to an unknown slug, for the same reason: a
 * companion we cannot render is worse than no companion.
 */
function parseOriginView(raw: string | null, onDrop: () => void): MenuViewRef | null {
  if (raw === null) return null;
  if (!raw.startsWith('v-') || raw.length <= 2) return null;
  const ref = dec(raw.slice(2)) ?? '';
  if (!Object.prototype.hasOwnProperty.call(VIEW_REF_ROUTE, ref)) {
    onDrop();
    return null;
  }
  return ref as MenuViewRef;
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
type CraftView = Extract<NavView, { view: 'craft' }>;

/** `/craft/…` segments → the craft view; ids only, cut at the first non-id. */
function craftOf(segments: readonly string[]): CraftView {
  const keys = ['designId', 'pageId', 'nestedPageId'] as const;
  const view: CraftView = { view: 'craft' };
  for (const [index, key] of keys.entries()) {
    const segment = segments[index];
    if (!segment || !ID_LIKE.test(segment)) break;
    view[key] = segment as EntityId;
  }
  return view;
}

/** The craft view → its path after `/craft`, each id only under the one before it. */
function craftPath(view: CraftView): string {
  if (!view.designId) return '';
  if (!view.pageId) return `/${enc(view.designId)}`;
  if (!view.nestedPageId) return `/${enc(view.designId)}/${enc(view.pageId)}`;
  return `/${enc(view.designId)}/${enc(view.pageId)}/${enc(view.nestedPageId)}`;
}

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

  const stack = parseIdList(query.get('p'), drop('stack'));

  /* O1 — A RETIRED `r=` LINK FOLDS, IT DOES NOT DROP.
     `r` carried Home's third panel, which no longer exists (U2/U6). A link to
     it still names a destination the viewer meant to reach, so `r`'s TOP — the
     entity that panel was actually showing — is appended to `p` and the rest of
     `r` is discarded SILENTLY. Folding rather than dropping-with-a-notice is
     the point: a notice tells the viewer something was lost, folding means
     nothing was. Because the fold lands the entity at the top of `p` and an
     absent `pc` means the top, the link opens on exactly the entity it named.
     When that entity is ALREADY on `p` below its top it cannot be appended (the
     Trail holds each entity once), so the fold SEEKS instead — the cursor goes
     to it, the same rule a live revisit follows. Appending nothing and seeking
     nothing would have opened the link on `p`'s top: the old centre, not the
     panel the link named. An explicit `pc` still outranks the fold.
     Deliberately reversible on review — see the PR body.
     Its drop callback is a NO-OP: `r` has no drop class any more, and a
     malformed one is exactly the "discard the rest silently" case. */
  const legacyRight = parseIdList(query.get('r'), () => {});
  const foldedTop = legacyRight.length > 0 ? legacyRight[legacyRight.length - 1]! : null;
  let foldedSeek: EntityId | null = null;
  if (foldedTop !== null) {
    if (!stack.includes(foldedTop)) stack.push(foldedTop);
    else if (stack[stack.length - 1] !== foldedTop) foldedSeek = foldedTop;
  }

  const panels: PanelState = {
    stack,
    pinned: parseIdList(query.get('pin'), drop('pins')),
    cursor: foldedSeek,
    tabs: parsePairs<PanelTab>(query.get('t'), TABS, drop('tabs')),
    contentSurface: parsePairs<ContentSurface>(
      query.get('contentSurface'),
      SURFACES,
      drop('tabs'),
      LEGACY_CONTENT_SURFACES,
    ),
    session: null,
    chat: null,
  };

  /* `pc` NAMES AN ENTRY OF `p`, so a `pc` that is not in `p` is not a cursor —
     it is a dangling address, and it clamps to the top under its own class
     rather than being honoured. Omitted is the COMMON case and means the top:
     that is what makes every pre-`pc` link parse to what it parses to today.
     A `pc` that is also PINNED is dangling too: `normalize`'s pin cross-filter
     takes it off the Trail, and this is the last tier that can still SAY so —
     past here the clamp to the top would happen with nothing reported (§3.2
     case 2). A pinned entry elsewhere on `p` is not a drop: the id absorbs the
     shift, which is what carrying an id rather than an index is for. */
  const cursorRaw = query.get('pc');
  if (cursorRaw !== null) {
    const cursor = dec(cursorRaw);
    if (
      cursor === null ||
      cursor.length === 0 ||
      !panels.stack.includes(cursor) ||
      panels.pinned.includes(cursor)
    ) {
      drop('cursor')();
      panels.cursor = null;
    } else {
      panels.cursor = cursor;
    }
  }

  const sessionRaw = query.get('session');
  if (sessionRaw !== null) {
    const session = dec(sessionRaw);
    if (session === null || session.length === 0) drop('session')();
    else panels.session = session;
  }

  /* THE CHAT SLOT (`ca` subject, `ct` thread). `ct` OMITTED ⇒ `new`, which is
     the canonical spelling `build` writes: a chat that does not exist yet has
     no id to put there. A `ct` with no subject is not a slot — a chat panel is
     always about something — so it drops under its own class rather than
     opening a subject-less panel. */
  const aboutRaw = query.get('ca');
  const threadRaw = query.get('ct');
  if (aboutRaw !== null || threadRaw !== null) {
    const about = aboutRaw === null ? null : dec(aboutRaw);
    const thread = threadRaw === null ? 'new' : dec(threadRaw);
    if (!about || !thread) drop('chat')();
    else panels.chat = { about, thread };
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
      return { view: 'home' };
    case 'home': {
      /* The unified Home's root segments (task 01a00932):
           /home              → the viewer's remembered root
           /home/k/{slug}     → root = that kind's list
           /home/chat[/{id}]  → root = chats, optionally the open thread.
         An unknown sub-segment is not a partial route: bare Home renders,
         same posture as the outer default case. The slug is deliberately
         pass-through (like `k/`) — the Home screen validates it against the
         registry and falls back to the remembered root, which keeps parse
         pure. */
      if (rest[1] === 'k' && rest[2]) {
        return { view: 'home', root: { type: 'kind', slug: rest[2] } };
      }
      if (rest[1] === 'chat') {
        /* `?stage=` names a Cockpit stage that is not an entity. Deliberately
           NOT a drop-notice param: any other value is a stale or foreign link
           and silently renders the plain conversation — lossy-tolerant, the
           rule inherited from the `?graph=full` parameter this replaces.

           BACK-COMPAT, decode-only (route-token preserve rule): `?graph=full`
           was the address of the fullscreen entity graph, and links to it are
           in histories and in pasted messages. It DECODES to the Graph stage,
           which is where that view lives now, so an old link still lands on
           the thing it named. Nothing ENCODES it — `build` only ever emits
           `?stage=`, so the alias fades from every URL the app produces
           without breaking the ones it already handed out.

           `?gf=` is not aliased and simply dies undecoded: it was opaque at
           this layer by design, it addressed a facet rail that no longer
           exists, and its state is reconstructible by the viewer in two
           clicks. Reviving a filter vocabulary to honour it would be keeping
           a feature alive to honour its own URL. */
        const raw = query.get('stage') ?? (query.get('graph') === 'full' ? 'graph' : null);
        const stage = COCKPIT_STAGES.has(raw as CockpitStage) ? (raw as CockpitStage) : null;
        /* `?about=` — the subject a new conversation here is about. Same
           lossy-tolerant posture as `?stage=`: anything that is not
           plausibly an entity id is simply not carried, and a subject that no
           longer exists is the SCREEN's problem to render honestly, not a
           reason to refuse the route. */
        const about = query.get('about');
        const aboutId = about && ID_LIKE.test(about) ? (about as EntityId) : null;
        return {
          view: 'home',
          root: {
            type: 'chats',
            threadId: rest[2] ?? null,
            ...(stage ? { stage } : {}),
            ...(aboutId ? { aboutId } : {}),
          },
        };
      }
      return { view: 'home' };
    }
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
    case 'board':
      /* The task Board (2026-08-16) — same flat whole-centre posture. */
      return { view: 'board' };
    case 'craft':
      /* Craft (2026-08-16) — bare, the Designs home; then up to three ids
         (design, page, nested page). Lossy-tolerant like `?about=`: the path
         is cut at the first segment that is not plausibly an id, so a
         mangled page still lands on its design. */
      return craftOf(rest.slice(1));
    case 'help': {
      /* The Help shelf (2026-08-19), with an optional open plate (2026-08-20)
         in the `settings/{section}` shape. The slug is NOT checked against the
         plate registry here: the codec owns the grammar and the screen is the
         one place that knows which plates exist, so an unknown slug arrives
         intact and Help falls back to its contents. */
      const plate = rest[1];
      return { view: 'help', plate: plate && plate.length > 0 ? plate : null };
    }
    case 'work':
    case 'tabs': {
      /* Work — the tabs view (Spec B §7; D31). `work` is the canonical path;
         `tabs` is its permanent decode alias (links to it are in chats and
         docs) and `build` never emits it. `?tab=` names the active entity
         tab. Lossy-tolerant like `?about=`: a non-id value is not carried. */
      const tab = query.get('tab');
      return tab && ID_LIKE.test(tab) ? { view: 'tabs', tab: tab as EntityId } : { view: 'tabs' };
    }
    case 'board-v2':
      /* Board v2 (2026-08-18) — hyphenated segment, camel member, exactly the
         `new-session` precedent. */
      return { view: 'boardV2' };
    case 'new-session':
      /* Hyphenated in the URL, camel in the union: the segment is read by
         people and the member is read by TypeScript. */
      return { view: 'newSession' };
    case 'voice': {
      /* Shaped like `channel/{id}`, because a voice room is addressed the same
         way one channel is: an id in the path, no collection view behind it. A
         bare `/voice` names nothing, so it falls back rather than rendering a
         room with no id. */
      const voiceChannelId = rest[1];
      if (!voiceChannelId) return { view: 'home' };
      return { view: 'voice', voiceChannelId };
    }
    case 'settings': {
      const section = rest[1];
      const known = SETTINGS_ROUTE_SECTIONS.find((candidate) => candidate === section);
      if (known) return { view: 'settings', section: known };
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
      {
        const rawOrigin = query.get('origin');
        const originView = parseOriginView(rawOrigin, drop('origin'));
        /* The view form wins when present, and the collection parser is not
           consulted for it — see `parseOriginView`. */
        /* PR 1004: the full-view mark and the story graph's filter. A bad
           value is simply absent — the filter's default IS the full read. */
        const full = query.get('full') === '1';
        const rawHops = query.get('hops');
        const hops = rawHops === '1' || rawHops === '2' || rawHops === '3' ? (Number(rawHops) as 1 | 2 | 3) : null;
        const rawKinds = query.get('kinds');
        const kinds = rawKinds === null ? null : rawKinds.split(',').map(dec).filter((k): k is string => !!k);
        const extra = {
          ...(full ? { full: true } : {}),
          ...(hops ? { hops } : {}),
          ...(kinds ? { kinds } : {}),
        };
        return originView
          ? { view: 'entity', entityId, origin: null, originView, ...extra }
          : { view: 'entity', entityId, origin: parseOrigin(rawOrigin, drop('origin')), ...extra };
      }
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
    case 'home': {
      const root = t.root ?? null;
      if (root?.type === 'kind') return `${base}/home/k/${enc(root.slug)}`;
      if (root?.type === 'chats' && root.threadId) return `${base}/home/chat/${enc(root.threadId)}`;
      /* `chats` with no thread is the default root: `/home` IS that address,
         so the canonical form drops the segment (normalize agrees) — UNLESS a
         stage is up, which needs the `/chat` segment to survive a round-trip,
         since bare `/home` does not read `stage` (nor the `graph` alias). */
      if (root?.type === 'chats' && (root.stage || root.aboutId)) return `${base}/home/chat`;
      return `${base}/home`;
    }
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
    case 'board':
      return `${base}/board`;
    case 'craft':
      return `${base}/craft${craftPath(t)}`;
    case 'help':
      return t.plate ? `${base}/help/${enc(t.plate)}` : `${base}/help`;
    case 'boardV2':
      return `${base}/board-v2`;
    case 'tabs':
      return `${base}/work`;
    case 'newSession':
      return `${base}/new-session`;
    case 'voice':
      /* Must match `registry.ts`'s voice `routeBuilder` exactly — that builder
         is the authority and has been emitting this shape all along. */
      return `${base}/voice/${enc(t.voiceChannelId)}`;
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
  if (t.view === 'home') {
    if (t.root?.type === 'chats' && t.root.stage) viewParams.push(['stage', t.root.stage]);
    if (t.root?.type === 'chats' && t.root.aboutId) viewParams.push(['about', t.root.aboutId]);
  } else if (t.view === 'kind') {
    if (t.mode) viewParams.push(['mode', t.mode]);
  } else if (t.view === 'entity') {
    if (t.originView) {
      /* Same parameter, prefixed form — so the address carries exactly one
         companion and round-trips through `parseOriginView`. */
      viewParams.push(['origin', `v-${enc(t.originView)}`]);
    } else if (t.origin) {
      const value = t.origin.mode ? `${enc(t.origin.slug)}.${t.origin.mode}` : enc(t.origin.slug);
      viewParams.push(['origin', value]);
    }
    if (t.full) viewParams.push(['full', '1']);
    if (t.hops) viewParams.push(['hops', String(t.hops)]);
    if (t.kinds) viewParams.push(['kinds', t.kinds.map(enc).join(',')]);
  } else if (t.view === 'channel') {
    if (t.msg) viewParams.push(['msg', enc(t.msg)]);
  } else if (t.view === 'tabs') {
    if (t.tab) viewParams.push(['tab', enc(t.tab)]);
  }
  if (route.panels.session) viewParams.push(['session', enc(route.panels.session)]);
  /* The chat slot rides with the VIEW params, outside every drop tier: it is
     two ids at most, and a link that silently lost the open chat would land
     on the entity with the conversation the sender meant nowhere in sight. */
  if (route.panels.chat) {
    viewParams.push(['ca', enc(route.panels.chat.about)]);
    if (route.panels.chat.thread !== 'new') viewParams.push(['ct', enc(route.panels.chat.thread)]);
  }

  const qParam: Param[] = t.view === 'kind' && t.q ? [['q', encodeQ(t.q)]] : [];
  const stackParam: Param[] = [];
  if (route.panels.stack.length) {
    stackParam.push(['p', idList(route.panels.stack)]);
    /* `pc` RIDES IN `p`'s OWN TIER, never its own. A `pc` that outlived the `p`
       it points into would be a dangling address, and the 2048-cap drop tiers
       are the one machine in this file that could manufacture one.
       Null ⇒ the cursor is at the top ⇒ the param is omitted entirely, which is
       why a Trail nobody has walked back through builds the same bytes it
       built before `pc` existed. */
    if (route.panels.cursor !== null) stackParam.push(['pc', enc(route.panels.cursor)]);
  }
  const pinParam: Param[] = route.panels.pinned.length ? [['pin', idList(route.panels.pinned)]] : [];
  const tabsParam: Param[] = [];
  if (Object.keys(route.panels.tabs).length) tabsParam.push(['t', pairs(route.panels.tabs)]);
  if (Object.keys(route.panels.contentSurface).length) {
    tabsParam.push(['contentSurface', pairs(route.panels.contentSurface)]);
  }

  // Drop tiers, most-droppable first. `t` and contentSurface go TOGETHER —
  // they are one tier, because surface state without tab state is a lie about
  // which panel the surface belongs to. The `right` tier is gone with the
  // third panel (U2/U6); `pc` did NOT take its place in the order — it is part
  // of the `stack` tier, because it is part of the Trail, not a supplement.
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

  /* THE CURSOR IS RESOLVED AGAINST THE CANONICAL STACK, which is the entire
     reason `pc` is an id. Both filters above can REMOVE an entry — the dedupe
     within `p`, and the pin cross-filter, which fires on a Trail that walked
     onto something pinned over in Work. An index would survive that silently
     and aim one place to the left, at a real entity, with correct-looking
     chrome. An id either still names its entity (the common case: an entry
     BEFORE the cursor was removed, and the cursor is simply unaffected) or is
     absent, and absent clamps to the top.

     Canonical form is NULL AT THE TOP, so `normalize ∘ normalize = normalize`
     holds and the omitted-`pc` link stays the one true spelling of "at the
     end". */
  const cursorTop = stack.length > 0 ? stack[stack.length - 1]! : null;
  const cursor =
    route.panels.cursor !== null &&
    route.panels.cursor !== cursorTop &&
    stack.includes(route.panels.cursor)
      ? route.panels.cursor
      : null;

  const tabs: Record<EntityId, PanelTab> = {};
  for (const [id, tab] of Object.entries(route.panels.tabs)) {
    if (open.has(id) && tab !== 'content') tabs[id] = tab;
  }

  const contentSurface: Record<EntityId, ContentSurface> = {};
  for (const [id, surface] of Object.entries(route.panels.contentSurface)) {
    if (open.has(id)) contentSurface[id] = surface;
  }

  /* Canonical Home root: `chats` with no thread IS the bare `/home` form —
     unless a stage is up or a subject is bound, both of which only the
     `/chat` segment carries (bare `/home` reads neither, so collapsing would
     lose them). */
  const target: NavView =
    route.target.view === 'home' &&
    route.target.root &&
    route.target.root.type === 'chats' &&
    route.target.root.threadId === null &&
    !route.target.root.stage &&
    !route.target.root.aboutId
      ? { view: 'home' }
      : route.target;

  return {
    spaceId: route.spaceId,
    target,
    panels: {
      stack,
      pinned,
      cursor,
      tabs,
      contentSurface,
      session: route.panels.session,
      /* PINNED TO ITS SUBJECT, NOT TO THE STACK (Q4): the slot survives every
         stack rule above untouched. A chat about an entity that is not open
         is exactly the case the slot exists for. */
      chat: route.panels.chat ?? null,
    },
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

// ---------------------------------------------------------------------------
// Work redirects (D31: three desktop modes — Work · Design · Observe)
// ---------------------------------------------------------------------------

/**
 * Where a retired DESKTOP address lands in Work (the tabs view), and what it
 * opens there. ONE TABLE, so every inbound link — chats, docs, the server's
 * `e/{id}` form links, Copy link from before D31 — is answered in one place.
 *
 * PURE AND NOT APPLIED HERE. The codec is shared with the phone, which keeps
 * Home as its chat screen (D16), so parsing never rewrites these routes: the
 * desktop branch of GateApp asks `workRedirectOf` and applies the answer with
 * replace history. The phone never asks.
 */
export interface WorkRedirect {
  /** The route to land on: Work, except Home's graph stage (Observe). */
  to: NavView;
  /** Entity ids to open as tabs, in order. Duplicates are already removed. */
  open: EntityId[];
  /** The tab to activate (one of `open`), or null to leave the active tab. */
  activate: EntityId | null;
  /** Ids walked before `activate`, oldest first: its seeded linked trail. */
  trail: EntityId[];
  /** The browser kind, as a URL slug; the caller resolves and checks it. */
  browserSlug: string | null;
  /** Open the activated tab's chat dock on this thread. */
  chat: { thread: EntityId | 'new' } | null;
  /**
   * The route names a kind or an entity that Work may not host (`k/{slug}`,
   * `e/{id}`). The caller redirects only when the kind is a Work kind and
   * otherwise keeps the route — those screens still exist for other kinds.
   */
  onlyForWorkKinds: boolean;
}

const WORK: NavView = { view: 'tabs' };

function uniq(ids: readonly (EntityId | null | undefined)[]): EntityId[] {
  const out: EntityId[] = [];
  for (const id of ids) if (id && !out.includes(id)) out.push(id);
  return out;
}

/**
 * The old panel params (`p`, `pin`, `t`, `session`, `ca`/`ct`) as tabs: every
 * id they name opens, the stack's cursor (else its top, else the chat
 * subject) activates, and the stack below the cursor is that tab's trail.
 */
function fromPanels(panels: PanelState, extra: Partial<WorkRedirect> = {}): WorkRedirect {
  const { stack, pinned, cursor, session, chat } = panels;
  const at = cursor && stack.includes(cursor) ? stack.indexOf(cursor) : stack.length - 1;
  const top = at >= 0 ? stack[at]! : null;
  const open = uniq([...pinned, ...stack, ...(Object.keys(panels.tabs) as EntityId[]), session, chat?.about]);
  const activate = top ?? chat?.about ?? pinned[pinned.length - 1] ?? session ?? open[open.length - 1] ?? null;
  return {
    to: WORK,
    open,
    activate,
    trail: top ? stack.slice(0, at) : [],
    browserSlug: null,
    chat: chat && chat.about === activate ? { thread: chat.thread } : null,
    onlyForWorkKinds: false,
    ...extra,
  };
}

type RedirectRow<V extends NavView['view']> = (target: Extract<NavView, { view: V }>, panels: PanelState) => WorkRedirect;

/** The table. A view with no row is not retired on the desktop and stays. */
const WORK_REDIRECTS: { [V in NavView['view']]?: RedirectRow<V> } = {
  /* Home: bare, `k/{slug}` (browser kind), `chat[/{id}]` (that chat as a tab;
     `?about=` opens the subject with its dock), `?stage=graph` (Observe), and
     its trail (`p` + `pc`) as a tab with a seeded linked trail. */
  home: (target, panels) => {
    const root = target.root;
    if (root?.type === 'kind') return fromPanels(panels, { browserSlug: root.slug });
    if (root?.type === 'chats') {
      if (root.stage === 'graph') return { ...fromPanels(panels), to: { view: 'graph' } };
      if (root.threadId) {
        const base = fromPanels(panels);
        const id = root.threadId as EntityId;
        return { ...base, open: uniq([...base.open, id]), activate: id, trail: [], chat: null, browserSlug: 'chats' };
      }
      if (root.aboutId) {
        const base = fromPanels(panels);
        return { ...base, open: uniq([...base.open, root.aboutId]), activate: root.aboutId, trail: [], chat: { thread: 'new' } };
      }
      /* The Fleet stage has no Work twin: the sessions list is its nearest. */
      return fromPanels(panels, { browserSlug: root.stage === 'fleet' ? 'sessions' : 'chats' });
    }
    return fromPanels(panels);
  },
  /* The old Work: its stack and pins become tabs, the top activated. */
  workspace: (_target, panels) => fromPanels(panels),
  board: (_target, panels) => fromPanels(panels),
  boardV2: (_target, panels) => fromPanels(panels),
  /* `k/{slug}`: Work with that kind in the browser, when Work hosts it. */
  kind: (target, panels) => fromPanels(panels, { browserSlug: target.slug, onlyForWorkKinds: true }),
  /* `e/{id}` and `e/{id}?full=1`: the entity as a tab, through the normal
     open flow, when Work hosts its kind. */
  entity: (target, panels) => {
    const base = fromPanels(panels);
    return { ...base, open: uniq([...base.open, target.entityId]), activate: target.entityId, trail: [], onlyForWorkKinds: true };
  },
};

/**
 * The Work redirect for a DESKTOP route, or null when the route is not
 * retired (Work itself, Design, Observe, inbox, settings, help, new-session…).
 */
export function workRedirectOf(route: Route): WorkRedirect | null {
  const row = WORK_REDIRECTS[route.target.view] as RedirectRow<NavView['view']> | undefined;
  return row ? row(route.target, route.panels) : null;
}
