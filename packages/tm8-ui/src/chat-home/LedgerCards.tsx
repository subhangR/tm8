/**
 * THE LEDGER'S WRITES, AS THE TRANSCRIPT SHOWS THEM — what the chat MADE is a
 * card, what it MOVED is a line, what it merely READ stays the quiet counted
 * sentence in `TurnParts` (advisor D9–D11, D17; mockup 01a0dc85).
 *
 *   ┃ ▣  Containers P1 — docker provider              CREATED
 *   ┃    New task · under ◆ Containers program
 *   ┃ ◉  Worker · provider interface                   ● LIVE
 *   ┃    Spawned session · Opus 5.5
 *     ◆ Provider interface  [open] → [working]
 *     ✎ Edited ◆ Provider interface (acceptance criteria)
 *
 * EVERYTHING HERE IS READ FROM THE FOLD (`ledger.ts`). A card exists only for
 * a create the fold accepted — settled, not refused, first of its id in the
 * thread — so "highlighted exactly once" is a property of the model, not of
 * this file's care.
 *
 * WHAT THE FOLD CANNOT KNOW arrives through `LedgerHostProvider`: a late title
 * (`resolveEntity`, the chips' cache), and a spawned session's CURRENT state
 * (`readEntity` + `livenessOf`, the fleet's read and the seam's verdict). A
 * context rather than props because the call sites sit inside `TurnParts`'
 * per-call ledger block, whose shape lane 3 owns; threading three more props
 * through it would be a merge conflict per lane per wave. A host that provides
 * nothing (a channel feed row) gets cards with no live claim — never a guess.
 *
 * THE LIVENESS LAW (ruling 10) holds here too: `LIVE` is reachable only from
 * the seam's `live` verdict. `DONE` / `FAILED` are the session's own recorded
 * terminal status — facts about the record, not liveness claims.
 */
import {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import type { EntityDetail, EntityId, WorkSessionStatus } from '@tm8/contract';
import type { SessionLiveness } from '../data/seam';
import { KindIcon } from '../domain/KindIcon';
import { getKind } from '../domain/registry';
import { useChatEntityRef, type ChatEntityResolver } from './EntityChip';
import { useFleetEntities, type FleetEntityReader } from './fleet/use-fleet-entities';
import {
  kindWord,
  type ChatLedger,
  type LedgerCreate,
  type LedgerEdit,
  type LedgerTransition,
} from './ledger';
import type { ChatModelOption } from './types';
import './ledger-cards.css';

/* ── the host's capabilities ─────────────────────────────────────────────── */

export interface LedgerHost {
  /** The chips' resolver — late titles for ids the fold only knows bare. */
  resolveEntity?: ChatEntityResolver | undefined;
  /** The fleet's `entities.get` — a spawned session's recorded status. */
  readEntity?: FleetEntityReader | undefined;
  /** The seam's verdict, the ONLY authority on live. */
  livenessOf?:
    | ((session: { id: string; status: WorkSessionStatus | null }) => SessionLiveness)
    | undefined;
  /** The model catalog, for a session's human model name. */
  models?: readonly ChatModelOption[] | undefined;
}

/** Which cards this transcript has already shown, and whether its first
 *  paint is behind it — see `useEnterOnce`. Absent without a provider. */
interface Entrances {
  seen: Set<string>;
  painted: { current: boolean };
}

const LedgerHostContext = createContext<LedgerHost & { entrances?: Entrances }>({});

export function LedgerHostProvider({
  resolveEntity,
  readEntity,
  livenessOf,
  models,
  children,
}: LedgerHost & { children: ReactNode }) {
  const [entrances] = useState<Entrances>(() => ({ seen: new Set(), painted: { current: false } }));
  /* A parent's effect runs after its children's, so every card of the first
     paint has recorded itself before this flips. */
  useEffect(() => {
    entrances.painted.current = true;
  }, [entrances]);
  const value = useMemo(
    () => ({ resolveEntity, readEntity, livenessOf, models, entrances }),
    [resolveEntity, readEntity, livenessOf, models, entrances],
  );
  return <LedgerHostContext.Provider value={value}>{children}</LedgerHostContext.Provider>;
}

/* ── shared pieces ───────────────────────────────────────────────────────── */

/** The kind's own word, capitalised — "Task", "Session". A name we do not have
 *  yet is said as its kind, never as an id (D14: no ids on the surface). */
function kindLabel(kind: string | undefined): string {
  return kind ? getKind(kind).label : 'Entity';
}

/** A status value in the registry's words for that kind (`in_review` →
 *  `in review`), the same words its status pill uses everywhere else. */
function statusWord(kind: string | undefined, value: string): string {
  const labels = kind ? getKind(kind).panel.statusPill?.labels : undefined;
  return labels?.[value] ?? value.replace(/_/g, ' ');
}

/** An entity the fold names: its label, or the chips' cached late read. */
function useLedgerLabel(id: string | null, ledger: ChatLedger) {
  const host = useContext(LedgerHostContext);
  const known = id ? ledger.labels.get(id) : undefined;
  const create = id ? ledger.creates.find((c) => c.id === id) : undefined;
  return useChatEntityRef(
    id ?? '',
    { kind: known?.kind ?? create?.kind ?? undefined, title: known?.title ?? create?.title ?? undefined },
    host.resolveEntity,
  );
}

/**
 * A CARD RISES ONCE, AND ONLY WHEN IT ARRIVES (D9). What the transcript
 * already held at its first paint is history and renders still — opening an
 * old thread must not make every card in it bounce. A card that mounts later
 * (a create streaming in) rises once; a remount of one already shown (a run's
 * step list regrouping around it) does not replay it. The record lives in the
 * provider — one per open thread — so nothing leaks between threads, or tests.
 * The initializer only reads; the id is recorded after mount, so StrictMode's
 * double render cannot eat the entrance.
 */
function useEnterOnce(id: string): boolean {
  const { entrances } = useContext(LedgerHostContext);
  const [enter] = useState(() => entrances !== undefined && entrances.painted.current && !entrances.seen.has(id));
  useEffect(() => {
    entrances?.seen.add(id);
  }, [entrances, id]);
  return enter;
}

/* ── the created / spawned card (D9, D10, D17) ───────────────────────────── */

export function CreatedCard({
  create,
  ledger,
  onOpenEntity,
}: {
  create: LedgerCreate;
  ledger: ChatLedger;
  onOpenEntity?: ((id: EntityId) => void) | undefined;
}) {
  const self = useLedgerLabel(create.id, ledger);
  const kind = create.spawned ? 'work_session' : self.kind;
  const enter = useEnterOnce(create.id);
  const titled = self.title !== undefined;
  const title = self.title ?? kindLabel(kind);

  const face = (
    <>
      <span className="tch-lcard__mark" aria-hidden>
        {kind ? <KindIcon kind={kind} size={14} /> : '◇'}
      </span>
      <span className="tch-lcard__text">
        <span className="tch-lcard__title" data-placeholder={titled ? undefined : ''}>
          {title}
        </span>
        <span className="tch-lcard__sub">
          {create.spawned ? (
            <SessionSubline create={create} />
          ) : (
            <CreateSubline create={create} kind={kind} ledger={ledger} />
          )}
        </span>
      </span>
      {create.spawned ? (
        <SessionTag id={create.id} />
      ) : (
        <span className="tch-lcard__tag" data-tone="created">
          Created
        </span>
      )}
    </>
  );

  const variant = create.spawned ? 'spawned' : 'created';
  return (
    <div
      className="tch-created"
      data-testid="chat-ledger-create"
      data-variant={variant}
      data-kind={kind}
    >
      {onOpenEntity ? (
        <button
          type="button"
          className="tch-lcard"
          data-variant={variant}
          data-enter={enter ? '' : undefined}
          onClick={() => onOpenEntity(create.id as EntityId)}
        >
          {face}
        </button>
      ) : (
        <div className="tch-lcard" data-variant={variant} data-enter={enter ? '' : undefined}>
          {face}
        </div>
      )}
    </div>
  );
}

/**
 * `New task · under ◆ Containers program` — where it LANDED (the result's
 * parent), or what it was attached to, or `at the root`. The parent is text
 * inside the card's one button: a second control nested in a button is not a
 * control, and the card already opens the thing that was made.
 */
function CreateSubline({
  create,
  kind,
  ledger,
}: {
  create: LedgerCreate;
  kind: string | undefined;
  ledger: ChatLedger;
}) {
  const relatedId = create.parentId ?? create.subjectId;
  const related = useLedgerLabel(relatedId, ledger);
  const lead = `New ${kind ? kindWord(kind, 1) : 'entity'}`;
  if (!relatedId) return <>{`${lead} · at the root`}</>;
  return (
    <>
      {`${lead} · ${create.parentId ? 'under' : 'on'} `}
      <span className="tch-lcard__rel">
        {related.kind ? (
          <span className="tch-lcard__relmark" aria-hidden>
            <KindIcon kind={related.kind} size={11} />
          </span>
        ) : null}
        <span className="tch-lcard__reltitle" data-placeholder={related.title ? undefined : ''}>
          {related.title ?? kindLabel(related.kind)}
        </span>
      </span>
    </>
  );
}

/** `Spawned session · Opus 5.5` — the model's catalog name, or nothing. */
function SessionSubline({ create }: { create: LedgerCreate }) {
  const host = useContext(LedgerHostContext);
  const model = create.model
    ? host.models?.find((option) => option.model === create.model)?.label
    : undefined;
  return <>{model ? `Spawned session · ${model}` : 'Spawned session'}</>;
}

type SessionVerdict = 'live' | 'waiting' | 'done' | 'failed';

const SESSION_TAG: Record<SessionVerdict, string> = {
  live: 'Live',
  waiting: 'Waiting',
  done: 'Done',
  failed: 'Failed',
};

function SessionTag({ id }: { id: string }) {
  const verdict = useSessionVerdict(id);
  if (!verdict) return null;
  return (
    <span className="tch-lcard__tag" data-tone={verdict} data-testid="chat-ledger-session-status">
      {verdict === 'live' ? <span className="tch-lcard__dot" aria-hidden /> : null}
      {SESSION_TAG[verdict]}
    </span>
  );
}

/** How often a card whose session is still going re-asks the seam. The seam
 *  refreshes its snapshot on its own cadence; this only re-reads it, so a
 *  session that ends after the turn does not stay `LIVE` on a quiet screen. */
export const SESSION_VERDICT_TICK_MS = 5000;

/**
 * A spawned session's tag, or null — never a guess (D10).
 *
 * The recorded status comes from the fleet's shared read (one per id, ever);
 * the live half is the seam's verdict, re-asked on a tick while the session
 * is not terminal. That shared read is frozen at whatever the session was
 * when first read — `running`, usually — so when the verdict says it is no
 * longer live, the card reads the record ONCE more to learn how it ended
 * (`exited` → Done, `failed` → Failed). A record that still says `running`
 * with no live process is stale: no tag, because none of the four words is
 * true of it.
 */
function useSessionVerdict(id: string): SessionVerdict | null {
  const host = useContext(LedgerHostContext);
  const reads = useFleetEntities(host.readEntity ? [id] : [], host.readEntity);
  const [fresh, setFresh] = useState<EntityDetail | null>(null);
  const cached = reads.get(id);
  const detail = fresh ?? (cached?.state === 'loaded' ? cached.detail : null);
  const status = detail
    ? ((detail.state as { status?: WorkSessionStatus }).status ?? null)
    : null;
  const terminal = status === 'exited' || status === 'failed';

  const [, setTick] = useState(0);
  const ticking = detail !== null && !terminal && host.livenessOf !== undefined;
  useEffect(() => {
    if (!ticking) return;
    const timer = setInterval(() => setTick((n) => n + 1), SESSION_VERDICT_TICK_MS);
    return () => clearInterval(timer);
  }, [ticking]);

  const liveness = detail && host.livenessOf ? host.livenessOf({ id, status }) : null;

  /* Once per verdict change, never in a loop: a stale record re-read still
     says `running`, and must not be re-read on every tick. */
  const refreshedFor = useRef<SessionLiveness | null>(null);
  const { readEntity } = host;
  const gone = liveness === 'stale' || liveness === 'not-running';
  useEffect(() => {
    // Live again (a resume): the next time it stops is a new ending to learn.
    if (liveness === 'live') refreshedFor.current = null;
    if (!gone || terminal || !readEntity || !liveness || refreshedFor.current === liveness) return;
    refreshedFor.current = liveness;
    let alive = true;
    readEntity(id as EntityId).then(
      (next) => {
        if (alive) setFresh(next);
      },
      () => {
        /* The record stays what we last knew; the tag stays honest (none). */
      },
    );
    return () => {
      alive = false;
    };
  }, [gone, terminal, readEntity, liveness, id]);

  if (!detail) return null;
  if (status === 'failed') return 'failed';
  if (status === 'exited') return 'done';
  if (liveness === 'live') return status === 'idle' ? 'waiting' : 'live';
  return null;
}

/* ── the transition line (D11) ───────────────────────────────────────────── */

/**
 * `◆ Provider interface  [open] → [working]`, degrading honestly to
 * `◆ Provider interface  → [done]` when this thread never saw the prior
 * status (ruling 13): a one-sided arrow is less than we wish we knew; an
 * invented left side would be a lie about history.
 */
export function TransitionRow({
  transition,
  ledger,
  onOpenEntity,
}: {
  transition: LedgerTransition;
  ledger: ChatLedger;
  onOpenEntity?: ((id: EntityId) => void) | undefined;
}) {
  const entity = useLedgerLabel(transition.entityId, ledger);
  const { from, to } = transition;
  return (
    <span className="tch-ledger__transition tch-ltrans" data-testid="chat-ledger-transition">
      <span className="tch-ltrans__glyph" aria-hidden>
        {entity.kind ? <KindIcon kind={entity.kind} size={12} /> : '◇'}
      </span>
      <EntityName id={transition.entityId} label={entity} onOpenEntity={onOpenEntity} />
      {from !== null ? (
        <>
          {' '}
          <span className="tch-ltrans__pill" data-side="from">
            {statusWord(entity.kind, from)}
          </span>
        </>
      ) : null}{' '}
      <span className="tch-ltrans__arrow">→</span>{' '}
      <span className="tch-ltrans__pill" data-side="to" data-done={to === 'done' ? '' : undefined}>
        {statusWord(entity.kind, to)}
      </span>
    </span>
  );
}

/* ── the edit line (D11) ─────────────────────────────────────────────────── */

/**
 * ONE quiet line for every non-status edit in the turn, drawn where the first
 * one happened: `✎ Edited ◆ Provider interface (acceptance criteria)`, or
 * `✎ Edited 4 entities` when the turn touched several. No card — an edit is
 * a change to something that already existed, not a thing the chat made.
 */
export function EditLine({
  edits,
  ledger,
  onOpenEntity,
}: {
  edits: readonly LedgerEdit[];
  ledger: ChatLedger;
  onOpenEntity?: ((id: EntityId) => void) | undefined;
}) {
  const ids = [...new Set(edits.map((edit) => edit.entityId))];
  const only = ids.length === 1 ? ids[0]! : null;
  const entity = useLedgerLabel(only, ledger);
  if (ids.length === 0) return null;
  const what = [...new Set(edits.flatMap((edit) => edit.what))];
  return (
    <span className="tch-ledger__edit" data-testid="chat-ledger-edit">
      <span className="tch-ledger__editmark" aria-hidden>
        ✎
      </span>{' '}
      Edited{' '}
      {only ? (
        <>
          <span className="tch-ltrans__glyph" aria-hidden>
            {entity.kind ? <KindIcon kind={entity.kind} size={12} /> : '◇'}
          </span>
          <EntityName id={only} label={entity} onOpenEntity={onOpenEntity} />
          {what.length > 0 ? ` (${what.join(', ')})` : null}
        </>
      ) : (
        `${ids.length} entities`
      )}
    </span>
  );
}

/**
 * The entity's name in a ledger line — a real button when the host can open
 * entities, an inert span when it cannot, so a press never lands on a control
 * that goes nowhere. Kind is never consulted for clickability.
 */
function EntityName({
  id,
  label,
  onOpenEntity,
}: {
  id: string;
  label: { kind: string | undefined; title: string | undefined };
  onOpenEntity?: ((id: EntityId) => void) | undefined;
}) {
  const text = label.title ?? kindLabel(label.kind);
  const placeholder = label.title === undefined ? '' : undefined;
  if (!onOpenEntity) {
    return (
      <span className="tch-ledger__entity" data-placeholder={placeholder}>
        {text}
      </span>
    );
  }
  return (
    <button
      type="button"
      className="tch-ledger__entity tch-ledger__open"
      data-placeholder={placeholder}
      onClick={() => onOpenEntity(id as EntityId)}
    >
      {text}
    </button>
  );
}
