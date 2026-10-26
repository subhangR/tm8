/**
 * WHAT THE LEDGER FOLD CANNOT KNOW, for the turn receipt (`TurnReceipt.tsx`):
 * a late title (`resolveEntity`, the chips' cache), a spawned session's
 * CURRENT state (`readEntity` + `livenessOf`, the fleet's read and the seam's
 * verdict), and an entity's status NOW rather than at the write. A context
 * rather than props because the receipt sits deep inside `TurnParts`' runs. A
 * host that provides nothing (a channel feed row) gets rows with no live
 * claim — never a guess.
 *
 * THE LIVENESS LAW (ruling 10) holds here too: `live` is reachable only from
 * the seam's `live` verdict. `completed` / `crashed` / `ended` are the
 * session's own recorded status — facts about the record, not liveness claims.
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
import { getKind } from '../domain/registry';
import { sessionOutcomeOf } from '../domain/session-outcome';
import { useChatEntityRef, type ChatEntityResolver } from './EntityChip';
import { useFleetEntities, type FleetEntityReader } from './fleet/use-fleet-entities';
import type { ChatLedger } from './ledger';
import type { ChatModelOption } from './types';

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

/** Which rows this transcript has already shown, and whether its first
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
export function kindLabel(kind: string | undefined): string {
  return kind ? getKind(kind).label : 'Entity';
}

/** A status value in the registry's words for that kind (`in_review` →
 *  `in review`), the same words its status pill uses everywhere else. */
export function statusWord(kind: string | undefined, value: string): string {
  const labels = kind ? getKind(kind).panel.statusPill?.labels : undefined;
  return labels?.[value] ?? value.replace(/_/g, ' ');
}

/** An entity the fold names: its label, or the chips' cached late read. */
export function useLedgerLabel(id: string | null, ledger: ChatLedger) {
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
export function useEnterOnce(id: string): boolean {
  const { entrances } = useContext(LedgerHostContext);
  const [enter] = useState(() => entrances !== undefined && entrances.painted.current && !entrances.seen.has(id));
  useEffect(() => {
    entrances?.seen.add(id);
  }, [entrances, id]);
  return enter;
}

/* SPEC D1 §5.7: the tag names the OUTCOME once the work is settled —
   Completed or Stopped — and the process only while the work is open: Live,
   Waiting, Crashed, or Ended (the process exited without completing). The old
   "exited → Done" read a clean exit as finished work, which it is not. */
export type SessionVerdict = 'live' | 'waiting' | 'completed' | 'stopped' | 'crashed' | 'ended';

export const SESSION_TAG: Record<SessionVerdict, string> = {
  live: 'Live',
  waiting: 'Waiting',
  completed: 'Completed',
  stopped: 'Stopped',
  crashed: 'Crashed',
  ended: 'Ended',
};

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
export function useSessionVerdict(id: string): SessionVerdict | null {
  const host = useContext(LedgerHostContext);
  const reads = useFleetEntities(host.readEntity ? [id] : [], host.readEntity);
  const [fresh, setFresh] = useState<EntityDetail | null>(null);
  const cached = reads.get(id);
  const detail = fresh ?? (cached?.state === 'loaded' ? cached.detail : null);
  const status = detail
    ? ((detail.state as { status?: WorkSessionStatus }).status ?? null)
    : null;
  const outcome = detail ? sessionOutcomeOf(detail.state) : 'open';
  // Settled work never changes its tag again (§3 rule 1), so it stops asking too.
  const terminal = status === 'exited' || status === 'failed' || outcome !== 'open';

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
  if (outcome === 'completed') return 'completed';
  if (outcome === 'stopped') return 'stopped';
  if (status === 'failed') return 'crashed';
  if (status === 'exited') return 'ended';
  if (liveness === 'live') return status === 'idle' ? 'waiting' : 'live';
  return null;
}


/** How often a row whose entity has a live worker re-reads its status. */
export const STATUS_NOW_TICK_MS = 10000;

/**
 * An entity's status NOW, not at the write (the receipt's trailing slot).
 *
 * The fold's last-write-wins status is the floor: it is what this thread did.
 * A worker spawned onto the task moves it without the thread seeing, so while
 * a `watch`ed session is live the row re-reads the entity on a tick, and it
 * reads once more whenever `nudge` (the sessions' verdicts) changes — a worker
 * that just finished has usually just moved its task. A read is kept only
 * while the fold's own status is what it was when the read was asked: a later
 * write in this thread outranks an older read. No host, no reads.
 */
export function useStatusNow(
  id: string | null,
  foldStatus: string | null,
  { watch, nudge }: { watch: boolean; nudge: string | null },
): string | null {
  const { readEntity } = useContext(LedgerHostContext);
  const [fresh, setFresh] = useState<{ status: string; fold: string | null } | null>(null);
  const [tick, setTick] = useState(0);
  useEffect(() => {
    if (!watch || !readEntity) return;
    const timer = setInterval(() => setTick((n) => n + 1), STATUS_NOW_TICK_MS);
    return () => clearInterval(timer);
  }, [watch, readEntity]);
  const asked = watch || nudge !== null;
  useEffect(() => {
    if (!id || !readEntity || !asked) return;
    let alive = true;
    readEntity(id as EntityId).then(
      (detail) => {
        const status = (detail.state as { status?: unknown } | null)?.status;
        if (alive && typeof status === 'string') setFresh({ status, fold: foldStatus });
      },
      () => {
        /* The fold's status stays the answer. */
      },
    );
    return () => {
      alive = false;
    };
  }, [id, readEntity, asked, tick, nudge, foldStatus]);
  return fresh && fresh.fold === foldStatus ? fresh.status : foldStatus;
}

/** The host's model catalog, for a session's human model name. */
export function useModelLabel(model: string | undefined): string | undefined {
  const { models } = useContext(LedgerHostContext);
  return model ? models?.find((option) => option.model === model)?.label : undefined;
}
