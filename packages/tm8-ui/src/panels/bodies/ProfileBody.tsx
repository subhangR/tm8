import type { EdgeView, EntityDetail, EntitySummary } from '@tm8/contract';
import type { SessionLiveness } from '../../data/seam';
import { KindIcon, getKind } from '../../domain';
import { memoryEpistemics, memoryScopeOf } from '../../domain/memory';
import { Avatar, Chip, Eyebrow, Markdown } from '../../kit';
/*
 * MODULE-DEEP, not through `terminal/index.ts`, deliberately: the barrel also
 * exports `LiveTerminal`, which pulls xterm into the graph of whatever imports
 * it. TerminalBody pays that cost because it mounts a terminal; a member's
 * profile panel must not. These two modules are pure presentation logic with
 * no DOM dependency (verified by import: the jsdom canvas warning this file
 * produced through the barrel is gone). Read-only, per the charter carve.
 */
import { presentSession, presentationStyle } from '../../terminal/session-presentation';
import { toSessionRow } from '../../terminal/session-row';
import { EmptyBody } from '../detail/PanelStates';
import { HollowInline, HollowStat } from '../honesty/HollowValue';
import './profile-body.css';

/**
 * THE PROFILE ARCHETYPE BODY — T0-4 "All 12 kinds", frames MEMBER (oracle
 * lines 400–448) and AGENT (lines 452–496).
 *
 * TWO SCREENS THAT LOOK NOTHING ALIKE, ONE CODE PATH. The human frame is an
 * identity header, three stat tiles and two chip rows; the agent frame is
 * persona prose, a four-cell fact grid, a working-on row, an equipped kit and
 * a session list. There is no `kind ===` here and there cannot be (§15.2 fails
 * the build on one): the anatomy IS the ordered block list the registry row
 * carries, exactly as `GenericBody` works, and this file only knows how to
 * draw each block TYPE. A third profile-shaped kind is a registry row, not an
 * edit here.
 *
 * EVERY BLOCK READS THE DETAIL STRUCTURALLY — "does this state carry the key
 * the registry named?" — never "is this a teammate?". That is also why an
 * unexpected entity cannot white-screen: an absent member renders its designed
 * absence and the rest of the body is unaffected.
 *
 * THE LIVENESS LAW, which this body is a consumer of (D6/D22/D27/D39, and the
 * defect artifact in gate-evidence): a VERDICT outranks a stored record at
 * every consumer, and the verdict arrives ONLY through `livenessOf` — never
 * derived from `activityAt`, never read off `state.status`. The session rows
 * hand the verdict and the record to `presentSession`, the module that already
 * owns that combination for the terminal, rather than re-deciding it here.
 *
 * WHAT THE ORACLE DRAWS THAT THIS DELIBERATELY DOES NOT: the working-on row's
 * green `● live` (line 479). See `LiveWorkBlock` — the record it is drawn from
 * carries no session to ask about, so that dot would be a record-derived
 * liveness claim.
 */

// ---------------------------------------------------------------------------
// The block vocabulary
// ---------------------------------------------------------------------------

/**
 * The block names this body renders. Exported so the registry seam is
 * assertable from a test (`ProfileBody.test.tsx`) rather than kept in two
 * heads: a row that declares a name absent from this list draws nothing, and
 * that must be a red, not a blank section.
 *
 * `items` is deliberately the SAME name `GenericBody` uses for a chip list —
 * one block name, one meaning, two renderers.
 */
export const PROFILE_BLOCKS = [
  'identity',
  'bio',
  'stat-tiles',
  'field-grid',
  'items',
  'live-work',
  'session-rows',
  'org-tree',
  'memory-set',
] as const;

export type ProfileBlockName = (typeof PROFILE_BLOCKS)[number];

/**
 * The registry's `ContentBlockRef` shape, widened at `block` to `string`.
 *
 * WHY WIDENED, stated as a constraint rather than a preference: the profile
 * block names above are additions to `domain/types.ts`'s closed
 * `ContentBlockKind` union, and that file belongs to the registry lane. A
 * `readonly ContentBlockRef[]` is assignable to `readonly ProfileBlockRef[]`
 * today, so the panel can pass `config.panel.blocks` straight through; once
 * the union grows, nothing here changes and the narrower type simply flows in.
 */
export interface ProfileBlockRef {
  block: string;
  /** Section eyebrow above the block. */
  label?: string;
  /** Block parameters — the "new display need = a new block parameter" seam. */
  params?: Readonly<Record<string, string | number | boolean>>;
}

export interface ProfileBodyProps {
  detail: EntityDetail;
  /** Ordered blocks from `registry(kind).panel.blocks` — registry DATA. */
  blocks: readonly ProfileBlockRef[];
  /**
   * THE verdict, per session id — `seam.liveness.statusOf`, threaded by the
   * shell. Absent means nobody asked, which reads as `unverified` and never as
   * running (D27). It is never computed here.
   */
  livenessOf?: (id: string) => SessionLiveness;
  /**
   * The clock, injected so relative times are deterministic under test — the
   * `GraphView` precedent. Defaults to the wall clock, because "started 2m
   * ago" is a fact about now and omitting it would lose a fact the oracle
   * draws.
   */
  now?: string;
  onOpenEntity?: (id: string) => void;
  /**
   * The ONE authoring seam in this body, and it deliberately raises INTENT
   * rather than taking a seam handle.
   *
   * This file's header calls itself presentation, and every other block here
   * reads a detail and draws it. Handing it `seam.commands` would make it the
   * first body in the tree that mutates the graph (verified: no body imports
   * createEntity/createEdge/deleteEdge). So `memory-set` calls back and the
   * VIEW performs the write — the same shape `EntityControls` uses for state
   * and assignment, and the same shape `GenericBody` uses for artifact
   * preview.
   *
   * Absent means the host wired no authoring, and the block then renders the
   * working set read-only rather than drawing dead controls.
   */
  memoryAuthoring?: MemoryAuthoring | null;
}

export interface MemoryAuthoring {
  /** Compose a new memory and remember it here. The host owns the form. */
  onAdd(): void;
  /**
   * Drop the `remembers` edge — and ONLY that edge. The memory entity
   * survives, which is not a nicety: 056's epistemic edges are append-only and
   * a memory is the target of other actors' marks, so deleting the claim
   * because one holder stopped tracking it would destroy other people's
   * evidence. Takes the EDGE id, so the block must keep edges and not just
   * peers.
   */
  onForget(edgeId: string, title: string): void;
  /** Set when authoring is refused, so controls disable WITH a reason (L6/D28). */
  refusal?: string | null;
  /** Edge ids currently in flight, so a row can say so instead of looking inert. */
  pending?: readonly string[];
}

export function ProfileBody({
  detail,
  blocks,
  livenessOf,
  now,
  onOpenEntity,
  memoryAuthoring,
}: ProfileBodyProps) {
  if (blocks.length === 0) {
    return (
      /* The tabpanel identity rides on BOTH branches: a Content tab whose
         `aria-controls` resolves to nothing when the body happens to be empty
         is a small real defect, not a styling detail. */
      <div
        className="pn-body"
        data-testid="profile-body"
        id="tabpanel-content"
        role="tabpanel"
        aria-labelledby="tab-content"
      >
        <EmptyBody
          glyph={<KindIcon kind={detail.kind} />}
          sentence="This profile renders universal fields only — its registry row declares no blocks. Nothing is invented."
        />
      </div>
    );
  }
  const nowIso = now ?? new Date().toISOString();
  return (
    <div
      className="pn-body pn-profile"
      data-testid="profile-body"
      id="tabpanel-content"
      role="tabpanel"
      aria-labelledby="tab-content"
    >
      {blocks.map((block, i) => (
        <ProfileBlock
          key={`${block.block}:${i}`}
          detail={detail}
          block={block}
          livenessOf={livenessOf}
          now={nowIso}
          onOpenEntity={onOpenEntity}
          memoryAuthoring={memoryAuthoring}
        />
      ))}
    </div>
  );
}

function ProfileBlock({
  detail,
  block,
  livenessOf,
  now,
  onOpenEntity,
  memoryAuthoring,
}: {
  detail: EntityDetail;
  block: ProfileBlockRef;
  livenessOf?: (id: string) => SessionLiveness;
  now: string;
  onOpenEntity?: (id: string) => void;
  memoryAuthoring?: MemoryAuthoring | null;
}) {
  const params = block.params ?? {};
  const body = (() => {
    switch (block.block) {
      case 'identity':
        return <IdentityBlock detail={detail} params={params} />;
      case 'bio':
        return <BioBlock detail={detail} params={params} />;
      case 'stat-tiles':
        return <StatTilesBlock detail={detail} params={params} />;
      case 'field-grid':
        return <FieldGridBlock detail={detail} params={params} />;
      case 'items':
        return <ItemsBlock detail={detail} params={params} onOpenEntity={onOpenEntity} />;
      case 'live-work':
        return <LiveWorkBlock detail={detail} params={params} now={now} onOpenEntity={onOpenEntity} />;
      case 'org-tree':
        return <OrgTreeBlock detail={detail} params={params} onOpenEntity={onOpenEntity} />;
      case 'memory-set':
        return (
          <MemorySetBlock
            detail={detail}
            params={params}
            onOpenEntity={onOpenEntity}
            authoring={memoryAuthoring}
          />
        );
      case 'session-rows':
        return (
          <SessionRowsBlock
            detail={detail}
            params={params}
            livenessOf={livenessOf}
            now={now}
            onOpenEntity={onOpenEntity}
          />
        );
      default:
        return null;
    }
  })();
  if (!body) return null;

  /**
   * The eyebrow carries a COUNT when the block asks for one — T0-4 line 481
   * draws `EQUIPPED · 2`, and the count is of the same list the block renders,
   * so the two can never disagree.
   *
   * NO DIVIDER between profile blocks: the oracle draws these as plain
   * gap-separated regions (lines 418–445), and the hairline rule agrees —
   * `--pn-line` bounds a COMPONENT, and these are regions inside one body, not
   * components. `.pn-section`'s bottom rule would be a hairline the canvas
   * does not draw.
   */
  /* An edge-backed block counts its EDGES, a content-backed one counts its
     list. Same rule either way — the count is of the very thing the block
     draws below it, so the two can never disagree. */
  const count =
    params.count === true
      ? (typeof params.edgeType === 'string' ? edgesOf(detail, params) : summariesOf(detail, params)).length
      : null;
  const label = block.label != null && count != null ? `${block.label} · ${count}` : block.label;

  return (
    <section className="pn-profile__block" data-testid={`block-${block.block}`}>
      {label ? <Eyebrow faint>{label}</Eyebrow> : null}
      {body}
    </section>
  );
}

type Params = Readonly<Record<string, string | number | boolean>>;

// ---------------------------------------------------------------------------
// Blocks
// ---------------------------------------------------------------------------

/**
 * IDENTITY — the header the member frame opens with (T0-4 lines 419–426):
 * avatar, name, role tag, and a mono caption line.
 *
 * SHAPE IS PROVENANCE (kit law): the registry says `provenance`, the kit draws
 * a circle for a human and a rounded square for an agent, and the caption
 * states it in words as well — shape is never the only carrier.
 *
 * PRESENCE IS HOLLOW, NOT `online` (D7.2). The oracle's caption reads
 * "human member · ● online"; presence is measured-empty on every node in this
 * program, so a green `online` would assert a measurement nobody took. The
 * dash says we never looked, and the reason is reachable.
 */
function IdentityBlock({ detail, params }: { detail: EntityDetail; params: Params }) {
  const state = record(detail.state);
  const provenance = params.provenance === 'agent' ? 'agent' : 'human';
  const tagKey = typeof params.tagKey === 'string' ? params.tagKey : null;
  const tag = tagKey ? scalar(state[tagKey]) : null;
  const caption = typeof params.caption === 'string' ? params.caption : null;

  return (
    <div className="pn-profile__identity">
      {/* 32 is the kit's largest declared size; the oracle draws 40 here.
          Stated as a divergence in the handover rather than fixed silently —
          `AvatarSize` is a closed union in kit/Avatar.tsx, another lane's file. */}
      <Avatar actorId={detail.id} provenance={provenance} label={detail.title} size={32} />
      <div className="pn-profile__identity-text">
        <div className="pn-profile__name">
          <span className="pn-profile__name-text">{detail.title}</span>
          {tag ? <span className="pn-profile__tag">{tag}</span> : null}
        </div>
        {caption ? (
          <div className="pn-profile__caption">
            <span>{caption}</span>
            {params.presence === true ? (
              <>
                <span aria-hidden> · </span>
                <HollowInline caption="Presence is measured-empty on every node in this build (D7.2) — nothing has looked, so no online state can be claimed.">
                  — presence
                </HollowInline>
              </>
            ) : null}
          </div>
        ) : null}
      </div>
    </div>
  );
}

/**
 * BIO — the persona prose the agent frame opens with (T0-4 line 472). Reuses
 * `.pn-prose`, which already carries that line's measurements (12.5px/1.55,
 * ink-2, `text-wrap: pretty`).
 */
function BioBlock({ detail, params }: { detail: EntityDetail; params: Params }) {
  const content = record(detail.content);
  const key = typeof params.source === 'string' ? params.source : null;
  const raw = key ? content[key] : null;
  const text = typeof raw === 'string' && raw.length > 0 ? raw : null;
  if (!text) return null;
  return <Markdown source={text} className="pn-prose" testId="pn-prose" />;
}

/**
 * STAT TILES — the member frame's three-across row (T0-4 lines 427–431).
 *
 * `params.tiles` is `sourceKey=LABEL` pairs: the registry names WHICH scalar
 * each tile reads and what it is called, so a fourth stat is a data edit. The
 * source is looked up in `state` first and then `content`; an array counts.
 *
 * DASH, NEVER ZERO (D7.2, via the kit's own `HollowStat`): a source the entity
 * does not carry renders `—` with its reason. Rendering `0` would claim a
 * measurement that never ran, and a measured zero — which this still shows as
 * `0` — is a different and honest answer.
 */
function StatTilesBlock({ detail, params }: { detail: EntityDetail; params: Params }) {
  const pairs = pairsOf(params.tiles);
  if (pairs.length === 0) return null;
  return (
    <div className="pn-profile__stats">
      {pairs.map(([key, label]) => {
        const value = countable(lookup(detail, key));
        return (
          <HollowStat
            key={key}
            label={label}
            value={value}
            caption={`Not recorded on this entity — nothing measured ${label}.`}
          />
        );
      })}
    </div>
  );
}

/**
 * FIELD GRID — the agent frame's two-column fact grid (T0-4 lines 474–478):
 * Model · Tool · Owner · Memories. `params.fields` is the same
 * `sourceKey=Label` vocabulary the stat tiles use.
 *
 * The VALUE renderer is structural: a scalar prints as itself, a list prints
 * its length (a real count of what we hold), an actor prints as a provenance
 * glyph plus its handle, and an absent value goes hollow rather than blank —
 * an empty cell is indistinguishable from a rendering bug.
 */
function FieldGridBlock({ detail, params }: { detail: EntityDetail; params: Params }) {
  const pairs = pairsOf(params.fields);
  if (pairs.length === 0) return null;
  return (
    <dl className="pn-profile__grid">
      {pairs.map(([key, label]) => (
        <div className="pn-profile__cell" key={key}>
          {/* dt/dd render INLINE and the separator is a literal space, because
              that is what the oracle draws (lines 474–478: `Model <span>…`) —
              a flex gap here would be an invented measurement. */}
          <dt className="pn-profile__cell-key">{label}</dt>{' '}
          <dd className="pn-profile__cell-value">
            <FieldValue value={lookup(detail, key)} label={label} />
          </dd>
        </div>
      ))}
    </dl>
  );
}

function FieldValue({ value, label }: { value: unknown; label: string }) {
  if (Array.isArray(value)) return <span className="pn-profile__mono">{value.length}</span>;
  if (isActor(value)) {
    return (
      <span className="pn-profile__actor">
        <Avatar
          actorId={value.id}
          provenance={value.isAgent === true ? 'agent' : 'human'}
          label={value.displayName}
          size={15}
          src={value.avatar ?? null}
        />
        {`@${value.displayName}`}
      </span>
    );
  }
  const text = scalar(value);
  if (text == null) {
    return (
      <HollowInline caption={`The record carries no ${label} for this entity.`}>—</HollowInline>
    );
  }
  return <span className="pn-profile__mono">{text}</span>;
}

/**
 * ITEMS — an `EntitySummary` chip row (T0-4 lines 433–444, 481–485).
 * `params.source` names the content member holding them, which is how one
 * block serves TEAMMATES OWNED, CURRENT WORK and EQUIPPED without naming any
 * of those kinds.
 *
 * `params.statusKey` names the state scalar carrying an item's status word
 * ("◔ T-114 · working"). It is registry DATA on purpose: the
 * `StatusSource → state key` map that would otherwise answer this already
 * exists twice in the tree (detail/chrome.tsx, graph/GraphView.tsx) and lives
 * in neither's shared home, so a third copy is the wrong fix.
 */
function ItemsBlock({
  detail,
  params,
  onOpenEntity,
}: {
  detail: EntityDetail;
  params: Params;
  onOpenEntity?: (id: string) => void;
}) {
  const items = summariesOf(detail, params);
  const statusKey = typeof params.statusKey === 'string' ? params.statusKey : null;

  if (items.length === 0) {
    // A designed empty, not an accidental one — same words `GenericBody` uses,
    // because it is the same state.
    const empty = typeof params.empty === 'string' ? params.empty : 'Nothing here yet.';
    return <p className="pn-section__empty">{empty}</p>;
  }
  return (
    <div className="pn-chiprow">
      {items.map((item) => {
        const status = statusKey ? scalar(record(item.state)[statusKey]) : null;
        return (
          <Chip
            key={item.id}
            glyph={<KindIcon kind={item.kind} />}
            onClick={() => onOpenEntity?.(item.id)}
          >
            {status ? `${item.title} · ${status.replace(/_/g, ' ')}` : item.title}
          </Chip>
        );
      })}
    </div>
  );
}

/**
 * LIVE WORK — the agent frame's working-on row (T0-4 line 479).
 *
 * WHAT IT SHOWS: the record's own facts — which task, and since when.
 *
 * WHAT IT REFUSES TO SHOW, and why this is the most important comment in the
 * file: the oracle draws a pulsing green dot and the word `live` on the right
 * of this row. The record it is drawn from is the contract's `LiveWork`
 * — `{actor, task, startedAt, note}` — which carries NO session reference.
 * There is therefore no id to hand `livenessOf`, and painting `live` from the
 * record alone is exactly the inference D6 forbids and D39 found reaching the
 * screen: a row that says live above a session the node has never heard of.
 * So the verdict slot goes HOLLOW with its reason. This is a MEASURED
 * constraint of today's contract, not a guess about the design: give `LiveWork`
 * a session reference and this row can carry a real verdict unchanged.
 */
function LiveWorkBlock({
  detail,
  params,
  now,
  onOpenEntity,
}: {
  detail: EntityDetail;
  params: Params;
  now: string;
  onOpenEntity?: (id: string) => void;
}) {
  const state = record(detail.state);
  const key = typeof params.source === 'string' ? params.source : 'liveWork';
  const work = record(state[key]);
  const task = isSummary(work.task) ? work.task : null;
  const startedAt = typeof work.startedAt === 'string' ? work.startedAt : null;

  if (!task) {
    // A real state the oracle never draws: an idle teammate. One quiet line —
    // an absence is stated, not shouted, and never taxes the surface.
    return <p className="pn-section__empty">Nothing recorded in progress.</p>;
  }

  return (
    <div className="pn-profile__livework">
      <span className="pn-profile__dot" aria-hidden />
      <span className="pn-profile__livework-label">working on</span>
      {/* Bare bold text, not a bordered chip: the oracle draws
          `<span style="font-size:12px;font-weight:600">◔ T-114</span>` inside
          this row (line 479), and a chip's border would box it twice. */}
      <button
        type="button"
        className="pn-profile__task"
        onClick={() => onOpenEntity?.(task.id)}
        title={task.title}
      >
        <span aria-hidden className="pn-profile__row-glyph">
          <KindIcon kind={task.kind} />
        </span>
        {task.title}
      </button>
      {startedAt ? (
        <span className="pn-profile__since">{`since ${elapsed(startedAt, now)} ago`}</span>
      ) : null}
      <span className="pn-profile__spacer" />
      <HollowInline caption="Unverified: this record names a task but no session, so there is nothing to ask the node about. A liveness verdict is never inferred from a stored record.">
        — unverified
      </HollowInline>
    </div>
  );
}

/**
 * ORG TREE — this entity's place in the team structure. NOT an oracle frame:
 * an addition, appended after the oracle's last block so the drawn frame above
 * stays contiguous.
 *
 * WHERE THE STRUCTURE COMES FROM, and why there is no teammate-shaped edge
 * here: `db/migrations/002_identity.sql:110` rules it outright — "the org tree
 * is the entity hierarchy (leader = parent)". So this reads `detail.hierarchy`
 * — the same parent/children/path every other body reads — and a leader is
 * simply a parent. There is no `member_of` traversal because that edge type is
 * named in a comment but is NOT in the seeded `edge_types` table; reading it
 * would draw structure the database cannot answer for.
 *
 * STRICTLY READ-ONLY. No re-parenting control is rendered, not even disabled:
 * the deferred-control law covers a control the design calls for, and the
 * design does not call for one here.
 *
 * IT DEGRADES BY SAYING SO. A teammate with no leader and no reports is the
 * common case in a team nobody has arranged, and that is a real fact about the
 * team rather than a rendering failure — so it states the absence and names
 * what would change it, instead of drawing a lone node in a tree that implies
 * structure was measured and found empty.
 */
function OrgTreeBlock({
  detail,
  params,
  onOpenEntity,
}: {
  detail: EntityDetail;
  params: Params;
  onOpenEntity?: (id: string) => void;
}) {
  const { parent, children } = detail.hierarchy;
  const reports = children.items;

  if (!parent && reports.length === 0) {
    const empty =
      typeof params.empty === 'string'
        ? params.empty
        : 'No leader and no reports — this teammate sits outside any team structure. The org tree is the entity hierarchy, so giving it a parent places it here.';
    return <p className="pn-section__empty">{empty}</p>;
  }

  // Leader, then this entity, then its reports — depth is the only thing that
  // encodes the relation, and each row says its role in words as well.
  const rows: Array<{ node: EntitySummary; depth: number; role: string; self: boolean }> = [];
  if (parent) rows.push({ node: parent, depth: 0, role: 'leads', self: false });
  rows.push({
    node: detail as EntitySummary,
    depth: parent ? 1 : 0,
    role: 'this teammate',
    self: true,
  });
  for (const child of reports) {
    rows.push({ node: child, depth: parent ? 2 : 1, role: 'reports to', self: false });
  }

  const total = children.total;
  return (
    <div className="pn-profile__org">
      {rows.map(({ node, depth, role, self }) => {
        const glyph = (
          <span aria-hidden className="pn-profile__row-glyph">
            <KindIcon kind={node.kind} />
          </span>
        );
        const label = (
          <>
            <span className="pn-profile__row-name">{node.title}</span>
            <span aria-hidden className="pn-profile__sep">
              ·
            </span>
            <span className="pn-profile__org-role">{role}</span>
          </>
        );
        return self ? (
          // The current entity is not a link to itself — that is a control
          // that looks live and does nothing.
          <div
            key={node.id}
            className="pn-profile__org-row pn-profile__org-row--self"
            data-depth={depth}
            aria-current="true"
          >
            {glyph}
            {label}
          </div>
        ) : (
          <button
            type="button"
            key={node.id}
            className="pn-profile__org-row"
            data-depth={depth}
            title={node.title}
            onClick={() => onOpenEntity?.(node.id)}
          >
            {glyph}
            {label}
          </button>
        );
      })}
      {typeof total === 'number' && total > reports.length ? (
        /* The count is of what we HOLD versus what the server says exists —
           SubtreeBody's precedent. A truncated tree that looks complete is the
           same defect class as an unverified `live`. */
        <p className="pn-section__empty">
          {reports.length} of {total} reports loaded.
        </p>
      ) : null}
    </div>
  );
}

/**
 * SESSION ROWS — RECENT SESSIONS (T0-4 lines 487–492).
 *
 * WHERE THE ROWS COME FROM: the connections edge group the registry names
 * (`params.edgeType`/`params.direction`). D46 ruled the session→teammate link
 * an EDGE, so this reads the edge rather than a content member that would have
 * to be kept in sync with it.
 *
 * WHERE THE WORD COMES FROM: `livenessOf` — the verdict — combined with the
 * row's RECORDED status by `presentSession`, the module that already owns that
 * combination for the terminal panel. The verdict settles "is there a PTY";
 * the record only says which kind of "no" this is (exited vs failed vs
 * spawning). No verdict at all lands on `unverified`, never on `running`.
 */
function SessionRowsBlock({
  detail,
  params,
  livenessOf,
  now,
  onOpenEntity,
}: {
  detail: EntityDetail;
  params: Params;
  livenessOf?: (id: string) => SessionLiveness;
  now: string;
  onOpenEntity?: (id: string) => void;
}) {
  const type = typeof params.edgeType === 'string' ? params.edgeType : null;
  const direction = params.direction === 'outgoing' ? 'outgoing' : 'incoming';
  const groups = direction === 'outgoing' ? detail.connections.outgoing : detail.connections.incoming;
  const peers = groups
    .filter((group) => type == null || group.type === type)
    .flatMap((group) => group.edges)
    .map((edge) => (edge.source.id === detail.id ? edge.target : edge.source));

  if (peers.length === 0) {
    const empty = typeof params.empty === 'string' ? params.empty : 'No sessions recorded yet.';
    return <p className="pn-section__empty">{empty}</p>;
  }

  return (
    <div className="pn-profile__rows">
      {peers.map((peer) => {
        const row = toSessionRow(peer);
        const style = presentationStyle(
          presentSession({
            liveness: livenessOf?.(peer.id) ?? 'unknown',
            recordedStatus: row.recordedStatus,
          }),
        );
        return (
          <button
            type="button"
            key={peer.id}
            className="pn-profile__row"
            onClick={() => onOpenEntity?.(peer.id)}
          >
            <span aria-hidden className="pn-profile__row-glyph">
              <KindIcon kind={peer.kind} />
            </span>
            <span className="pn-profile__row-name">{row.name}</span>
            <span aria-hidden className="pn-profile__sep">
              —
            </span>
            <span className="pn-profile__word" data-tone={style.tone} title={style.full}>
              {style.word}
            </span>
            <span aria-hidden className="pn-profile__sep">
              ·
            </span>
            <span className="pn-profile__ago">{elapsed(peer.activityAt, now)}</span>
          </button>
        );
      })}
    </div>
  );
}

/**
 * MEMORY SET — the memories this entity `remembers` (056/084/085).
 *
 * WHY THIS REPLACES A NUMBER. The teammate frame used to render memories as a
 * `field-grid` cell, and `FieldValue` prints any array as `value.length`. After
 * 084 emptied `team_members.memories` that cell prints `0` forever: a count of
 * a column nobody writes, next to a graph nobody was reading. A stat that can
 * only ever be zero is worse than no stat, because it reads as a measurement.
 *
 * WHY IT IS EDGE-BACKED AND NOT KIND-BOUND. 085 widened `remembers.src_kinds`
 * to the wildcard, so a task holds a working set exactly like a teammate does.
 * This block therefore names an EDGE TYPE in registry params and never a kind —
 * the same row on a task panel needs no code here, which is the §15.2 rule
 * paying for itself.
 *
 * THE TWO FACTS PER ROW, and the reason this block exists at all:
 *   · REMEMBERED — the edge is present. That is what the list is.
 *   · INJECTED — whether a spawn would actually hand this to the agent.
 * They are NOT the same fact. `execution-handlers.ts:162` drops superseded
 * memories from a working set while the edge survives, so a row can be in the
 * set and still never reach a session. Drawing those rows identically would
 * tell the reader the teammate carries context it does not carry — see
 * `domain/memory.ts` for the measurement. So a dropped row is struck and says
 * `not injected` in words.
 */
function MemorySetBlock({
  detail,
  params,
  onOpenEntity,
  authoring,
}: {
  detail: EntityDetail;
  params: Params;
  onOpenEntity?: (id: string) => void;
  authoring?: MemoryAuthoring | null;
}) {
  const edges = edgesOf(detail, params);
  const refusal = authoring?.refusal ?? null;
  const pending = new Set(authoring?.pending ?? []);

  const add = authoring ? (
    <button
      type="button"
      className="pn-memory__add"
      data-testid="memory-add"
      // L6/D28: refused controls stay FOCUSABLE so the reason is reachable.
      aria-disabled={refusal ? true : undefined}
      title={refusal ?? 'Author a memory and add it to this working set'}
      onClick={(event) => (refusal ? event.preventDefault() : authoring.onAdd())}
    >
      + remember something
    </button>
  ) : null;

  if (edges.length === 0) {
    const empty =
      typeof params.empty === 'string'
        ? params.empty
        : 'No memories remembered here yet. A memory is a scope-carrying claim — what was measured, how, and what it does not establish.';
    return (
      <div className="pn-memory">
        <p className="pn-section__empty">{empty}</p>
        {add}
      </div>
    );
  }

  return (
    <div className="pn-memory">
      <div className="pn-memory__rows">
        {edges.map((edge) => {
          const peer = edge.source.id === detail.id ? edge.target : edge.source;
          const mark = memoryEpistemics(peer.badges);
          const scope = memoryScopeOf(peer);
          const inFlight = pending.has(edge.id);
          return (
            <div
              key={edge.id}
              className="pn-memory__row"
              data-testid="memory-row"
              data-injected={mark.injected ? 'yes' : 'no'}
            >
              <button
                type="button"
                className="pn-memory__claim"
                onClick={() => onOpenEntity?.(peer.id)}
                title={peer.title}
              >
                <span aria-hidden className="pn-profile__row-glyph">
                  <KindIcon kind={peer.kind} />
                </span>
                <span className="pn-memory__statement">{peer.title}</span>
              </button>
              <span className="pn-memory__marks">
                <span className="pn-memory__mark" data-tone={mark.tone} title={mark.full}>
                  {mark.word}
                </span>
                {/* Stated only when it is FALSE. "injected" on every healthy row
                    would be noise; "not injected" is the exception a reader
                    must not miss, and it carries the mechanism in its title. */}
                {mark.injected ? null : (
                  <span className="pn-memory__mark" data-tone="bad" title={mark.full}>
                    not injected
                  </span>
                )}
              </span>
              {/* The scope, from the SUMMARY — 056 puts these in `state` so they
                  travel with the title and a row never has to fetch a detail to
                  say what a claim ranges over. */}
              {scope && scope.subjectScope.length > 0 ? (
                <span className="pn-memory__scope" title={`Does not establish: ${scope.doesNotEstablish}`}>
                  {scope.subjectScope}
                </span>
              ) : null}
              {authoring ? (
                <button
                  type="button"
                  className="pn-memory__forget"
                  data-testid="memory-forget"
                  aria-disabled={refusal || inFlight ? true : undefined}
                  aria-label={`Forget: ${peer.title}`}
                  title={
                    refusal ??
                    (inFlight
                      ? 'Removing…'
                      : 'Drop the remembers edge. The memory entity survives — other actors\u2019 marks on it are evidence and are never deleted from here.')
                  }
                  onClick={(event) =>
                    refusal || inFlight ? event.preventDefault() : authoring.onForget(edge.id, peer.title)
                  }
                >
                  {inFlight ? '…' : 'forget'}
                </button>
              ) : null}
            </div>
          );
        })}
      </div>
      {add}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Structural readers — they ask what the data HAS, never what it IS (§15.2)
// ---------------------------------------------------------------------------

function record(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

/** `key=Label` pairs, comma-separated. Tolerates the array form a future
    widening of `params` would allow, so the block survives that change. */
function pairsOf(raw: unknown): Array<[string, string]> {
  const parts: string[] = typeof raw === 'string' ? raw.split(',') : Array.isArray(raw) ? raw.map(String) : [];
  const pairs: Array<[string, string]> = [];
  for (const part of parts) {
    const [key, label] = part.split('=');
    const k = key?.trim();
    if (!k) continue;
    pairs.push([k, (label ?? k).trim()]);
  }
  return pairs;
}

/** `state` first, then `content` — the registry names a key, not a home. */
function lookup(detail: EntityDetail, key: string): unknown {
  const state = record(detail.state);
  if (key in state) return state[key];
  return record(detail.content)[key];
}

/** A list counts; a scalar is itself; anything else is not a measurement. */
function countable(value: unknown): number | string | null {
  if (Array.isArray(value)) return value.length;
  if (typeof value === 'number') return value;
  if (typeof value === 'string') return value.length > 0 ? value : null;
  return null;
}

/**
 * Scalars only. `null` returns null — a missing value is not a value, and
 * printing "null" into a field cell is the small end of the same dishonesty as
 * printing "0" for unmeasured presence.
 */
function scalar(value: unknown): string | null {
  if (value == null) return null;
  if (typeof value === 'string') return value.length > 0 ? value : null;
  if (typeof value === 'number') return String(value);
  if (typeof value === 'boolean') return value ? 'yes' : 'no';
  return null;
}

function isActor(value: unknown): value is { id: string; displayName: string; isAgent?: boolean; avatar?: string | null } {
  const bag = record(value);
  return typeof bag.id === 'string' && typeof bag.displayName === 'string';
}

function isSummary(value: unknown): value is EntitySummary {
  const bag = record(value);
  return typeof bag.id === 'string' && typeof bag.kind === 'string' && typeof bag.title === 'string';
}

function summariesOf(detail: EntityDetail, params: Params): readonly EntitySummary[] {
  const key = typeof params.source === 'string' ? params.source : 'items';
  const raw = record(detail.content)[key];
  return Array.isArray(raw) ? raw.filter(isSummary) : [];
}

/**
 * The edges of the group the registry names (`params.edgeType`/`direction`).
 *
 * Returns EDGES and not peers, because an edge-backed block that offers to
 * remove a link needs the edge's own id — `edges.delete` takes the edge, and
 * re-deriving it from a peer id would be a second lookup free to pick the wrong
 * one when two edge types join the same pair.
 */
function edgesOf(detail: EntityDetail, params: Params): readonly EdgeView[] {
  const type = typeof params.edgeType === 'string' ? params.edgeType : null;
  const direction = params.direction === 'incoming' ? 'incoming' : 'outgoing';
  const groups = direction === 'outgoing' ? detail.connections.outgoing : detail.connections.incoming;
  return groups.filter((group) => type == null || group.type === type).flatMap((group) => group.edges);
}

/**
 * Elapsed time as the oracle writes it: `2m`, `3h`, `2d` (line 479 composes
 * "since 2m ago"; line 490 uses the bare form). A near twin of `GraphView`'s
 * private `timeAgo`, which returns the "…ago" form instead — they differ in
 * output, so this is not a copy of it. A shared home in `domain/` is the right
 * fix and belongs to that lane; flagged rather than assumed.
 */
function elapsed(iso: string, now: string): string {
  const mins = Math.max(0, Math.round((Date.parse(now) - Date.parse(iso)) / 60_000));
  if (mins < 1) return '<1m';
  if (mins < 60) return `${mins}m`;
  const hours = Math.round(mins / 60);
  if (hours < 48) return `${hours}h`;
  return `${Math.round(hours / 24)}d`;
}
