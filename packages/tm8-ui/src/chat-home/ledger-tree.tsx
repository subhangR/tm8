/**
 * LEDGER TREE — the one component for the ledger's two TREE surfaces
 * (ruling 7, as amended 2026-08-21): the sticky panel's scope-filtered tree
 * and the transcript's expanded read line. They differ only in filter props.
 * The graph stage shares the MODEL, never this component — `CockpitGraphCanvas`
 * is a canvas and forcing it behind this API would be false unification.
 *
 * WHAT IT RENDERS: the ledger model's entities as an indented forest —
 * `parentOf` links draw a child under its nearest VISIBLE ancestor, so a kind
 * filter that hides the middle of a chain still shows the ends rather than
 * dropping them. Order is the model's own first-seen order, which is the one
 * order streaming never reshuffles (the same stability rule the tray and the
 * graph hold).
 *
 * WHAT IT REFUSES TO DO:
 *  · It never derives liveness or status words for sessions. `statusOf` is the
 *    host's verdict channel — S4 builds it from `groupFleetRows(fleetRowsOf(…))`
 *    — because a surface re-deriving the liveness law is "the fourth place that
 *    law could rot" (ruling 10). Absent a host verdict, a node's word is the
 *    model's own `currentState` entry: last-write-wins graph truth, which is a
 *    different fact from liveness and safe to render from here.
 *  · It never names a tool (R8). The ledger says what happened to the graph.
 *  · A row is a button only where the press can land: absent `onOpenEntity`
 *    the row renders as an inert span — EntityTray's honesty rule, which is
 *    also what keeps this component correct on every host D1 gates out.
 *
 * THE KIND CHIPS are a view filter, not a host verb, so they are live even on
 * a host that wires nothing else. Counts are computed over the SCOPED set
 * before the kind filter — a chip that renumbered as you toggled its siblings
 * would be counting its own shadow.
 */
import { useEffect, useMemo, useState } from 'react';
import type { EntityId } from '@tm8/contract';
import { KindIcon } from '../domain/KindIcon';
import { Pill, type PillTone } from '../kit';
import { resolveChatEntity, type ChatEntityResolver } from './EntityChip';
import { truncateEntityId } from './entity-refs';
import { kindWord, type ChatLedger } from './ledger';

/** `model` IS S2's ChatLedger — the committed export, one fold for every
 *  surface. The alias keeps the props' vocabulary. */
export type LedgerTreeModel = ChatLedger;

export interface LedgerTreeFilter {
  /** `'sessions'` — the work sessions this chat created; an entity id — the
   *  entities this chat created under it (§7.2). Absent — every creation. */
  scope?: 'sessions' | EntityId | undefined;
  /** With `readsOnly`, the expanded read line's filter: one turn, its reads. */
  turnMessageId?: string | undefined;
  readsOnly?: boolean | undefined;
}

/** The host's status verdict for one node, rendered VERBATIM. */
export interface LedgerNodeStatus {
  word: string;
  tone?: PillTone | undefined;
  dot?: 'pulse' | 'solid' | null | undefined;
  /** Long-form honest sentence for a degraded verdict, as the pill's title. */
  detail?: string | undefined;
}

export interface LedgerTreeProps {
  model: LedgerTreeModel;
  filter?: LedgerTreeFilter | undefined;
  /** Controlled kind selection; omit both for internal state (all kinds on). */
  selectedKinds?: ReadonlySet<string> | undefined;
  onSelectedKindsChange?: ((next: ReadonlySet<string>) => void) | undefined;
  /** Absent ⇒ rows render inert — never a dead control. */
  onOpenEntity?: ((id: EntityId) => void) | undefined;
  /** Lazily resolves title/kind for ids the model only knows bare. */
  resolveEntity?: ChatEntityResolver | undefined;
  /** The host's verdict channel (sessions liveness words live HERE, computed
   *  by the host from `fleetRowsOf` — ruling 10). Overrides `currentState`. */
  statusOf?: ((id: string) => LedgerNodeStatus | null) | undefined;
}

interface LedgerNode {
  id: string;
  kind: string | undefined;
  title: string | undefined;
  children: LedgerNode[];
}

/** The scoped id set, BEFORE the kind filter — the set the chips count. */
function scopedIds(model: LedgerTreeModel, filter: LedgerTreeFilter): readonly string[] {
  if (filter.readsOnly && filter.turnMessageId !== undefined) {
    return model.turns.find((t) => t.messageId === filter.turnMessageId)?.reads.ids ?? [];
  }
  if (filter.scope === 'sessions') {
    /* The `spawned` flag is the authority, not the kind — a spawn whose kind
       has not resolved yet is still a session this chat created (D3). */
    return model.creates.filter((c) => c.spawned).map((c) => c.id);
  }
  const created = model.creates.map((c) => c.id);
  if (filter.scope === undefined) return created;
  const scope = filter.scope as string;
  return created.filter((id) => {
    for (
      let parent = parentIdOf(model, id), hops = 0;
      parent !== undefined && hops < 64;
      parent = parentIdOf(model, parent), hops++
    ) {
      if (parent === scope) return true;
    }
    return false;
  });
}

/** `parentOf` distinguishes "explicitly rootless" (null) from "unknown"
 *  (absent); this widget treats both as "no parent". */
function parentIdOf(model: LedgerTreeModel, id: string): string | undefined {
  return model.parentOf.get(id) ?? undefined;
}

function kindOf(model: LedgerTreeModel, id: string): string | undefined {
  return model.labels.get(id)?.kind ?? model.creates.find((c) => c.id === id)?.kind ?? undefined;
}

function titleOf(model: LedgerTreeModel, id: string): string | undefined {
  return model.labels.get(id)?.title ?? model.creates.find((c) => c.id === id)?.title ?? undefined;
}

/** Forest over the visible set: each node hangs under its nearest visible
 *  ancestor, so filtering a chain's middle never drops its ends. */
function buildForest(model: LedgerTreeModel, ids: readonly string[]): LedgerNode[] {
  const visible = new Set(ids);
  const nodes = new Map<string, LedgerNode>();
  for (const id of ids) {
    nodes.set(id, {
      id,
      kind: kindOf(model, id),
      title: titleOf(model, id),
      children: [],
    });
  }
  const roots: LedgerNode[] = [];
  for (const id of ids) {
    const node = nodes.get(id)!;
    let parent = parentIdOf(model, id);
    for (let hops = 0; parent !== undefined && !visible.has(parent) && hops < 64; hops++) {
      parent = parentIdOf(model, parent);
    }
    if (parent !== undefined && parent !== id && nodes.has(parent)) {
      nodes.get(parent)!.children.push(node);
    } else {
      roots.push(node);
    }
  }
  return roots;
}

export function LedgerTree({
  model,
  filter = {},
  selectedKinds,
  onSelectedKindsChange,
  onOpenEntity,
  resolveEntity,
  statusOf,
}: LedgerTreeProps) {
  /* Uncontrolled fallback: empty set means "no filter" (all kinds shown),
     so a freshly mounted tree never starts blank. */
  const [ownSelection, setOwnSelection] = useState<ReadonlySet<string>>(new Set());
  const selection = selectedKinds ?? ownSelection;
  const setSelection = onSelectedKindsChange ?? setOwnSelection;

  const ids = useMemo(() => scopedIds(model, filter), [model, filter]);

  /* Counts over the scoped set, BEFORE the kind filter — a chip must not
     count its own shadow. Unknown kind buckets as 'entity', never dropped. */
  const kindCounts = useMemo(() => {
    const counts = new Map<string, number>();
    for (const id of ids) {
      const kind = kindOf(model, id) ?? 'entity';
      counts.set(kind, (counts.get(kind) ?? 0) + 1);
    }
    return counts;
  }, [model, ids]);

  const filtered = useMemo(
    () =>
      selection.size === 0
        ? ids
        : ids.filter((id) => selection.has(kindOf(model, id) ?? 'entity')),
    [model, ids, selection],
  );

  const forest = useMemo(() => buildForest(model, filtered), [model, filtered]);

  /* Nothing in scope ⇒ nothing at all — the same zero-state honesty the tray
     holds. The HOST says what emptiness means (S4's panel, S3b's line); an
     empty bordered widget would say it twice. */
  if (ids.length === 0) return null;

  const toggleKind = (kind: string): void => {
    const next = new Set(selection);
    if (next.has(kind)) next.delete(kind);
    else next.add(kind);
    setSelection(next);
  };

  return (
    <div className="tch-ledger-tree" data-testid="ledger-tree">
      {kindCounts.size > 1 ? (
        <div className="tch-ledger-tree__kinds" role="group" aria-label="Filter by kind">
          {[...kindCounts.entries()].map(([kind, count]) => (
            <button
              key={kind}
              type="button"
              className="tch-ledger-tree__kind"
              data-testid="ledger-kind-chip"
              data-kind={kind}
              aria-pressed={selection.size === 0 ? undefined : selection.has(kind)}
              onClick={() => toggleKind(kind)}
            >
              {`${count} ${kindWord(kind ?? 'entity', count)}`}
            </button>
          ))}
        </div>
      ) : null}
      <ul className="tch-ledger-tree__list" data-testid="ledger-forest">
        {forest.map((node) => (
          <LedgerBranch
            key={node.id}
            node={node}
            model={model}
            onOpenEntity={onOpenEntity}
            resolveEntity={resolveEntity}
            statusOf={statusOf}
          />
        ))}
      </ul>
    </div>
  );
}

function LedgerBranch({
  node,
  model,
  onOpenEntity,
  resolveEntity,
  statusOf,
}: {
  node: LedgerNode;
  model: LedgerTreeModel;
  onOpenEntity?: ((id: EntityId) => void) | undefined;
  resolveEntity?: ChatEntityResolver | undefined;
  statusOf?: ((id: string) => LedgerNodeStatus | null) | undefined;
}) {
  return (
    <li className="tch-ledger-tree__branch">
      <LedgerRow
        node={node}
        model={model}
        onOpenEntity={onOpenEntity}
        resolveEntity={resolveEntity}
        statusOf={statusOf}
      />
      {node.children.length > 0 ? (
        <ul className="tch-ledger-tree__list tch-ledger-tree__list--nested">
          {node.children.map((child) => (
            <LedgerBranch
              key={child.id}
              node={child}
              model={model}
              onOpenEntity={onOpenEntity}
              resolveEntity={resolveEntity}
              statusOf={statusOf}
            />
          ))}
        </ul>
      ) : null}
    </li>
  );
}

function LedgerRow({
  node,
  model,
  onOpenEntity,
  resolveEntity,
  statusOf,
}: {
  node: LedgerNode;
  model: LedgerTreeModel;
  onOpenEntity?: ((id: EntityId) => void) | undefined;
  resolveEntity?: ChatEntityResolver | undefined;
  statusOf?: ((id: string) => LedgerNodeStatus | null) | undefined;
}) {
  /* Same lazy resolution the chips use — and the SAME module cache, so a
     title the tray already fetched costs this tree nothing. */
  const [resolved, setResolved] = useState<{ kind?: string; title?: string } | null>(null);
  const needsResolve = node.title === undefined && resolveEntity !== undefined;
  useEffect(() => {
    if (!needsResolve || resolveEntity === undefined) return;
    let alive = true;
    resolveChatEntity(node.id, resolveEntity).then(
      (ref) => {
        if (alive) setResolved(ref);
      },
      () => {
        /* Failure keeps the truncated id — the row stays, saying what it
           honestly knows. */
      },
    );
    return () => {
      alive = false;
    };
  }, [needsResolve, node.id, resolveEntity]);

  const kind = node.kind ?? resolved?.kind;
  const title = node.title ?? resolved?.title;
  /* The host's verdict wins; the model's last-write-wins state is the fallback
     fact. Neither is ever computed here. */
  const verdict = statusOf?.(node.id) ?? null;
  const state = model.statusNow.get(node.id);
  const status: LedgerNodeStatus | null = verdict ?? (state !== undefined ? { word: state } : null);

  const body = (
    <>
      <span aria-hidden className="tch-ledger-tree__icon">
        {kind ? <KindIcon kind={kind} size={12} /> : '◇'}
      </span>
      <span className="tch-ledger-tree__title" data-placeholder={title === undefined || undefined}>
        {title ?? truncateEntityId(node.id)}
      </span>
      {status ? (
        <Pill
          tone={status.tone ?? 'idle'}
          {...(status.dot === 'pulse'
            ? { dot: 'pulse' as const }
            : status.dot === 'solid'
              ? { dot: 'solid' as const }
              : {})}
          {...(status.detail ? { title: status.detail } : {})}
        >
          {status.word}
        </Pill>
      ) : null}
    </>
  );

  return onOpenEntity ? (
    <button
      type="button"
      className="tch-ledger-tree__row"
      data-testid="ledger-row"
      data-id={node.id}
      title={node.id}
      onClick={() => onOpenEntity(node.id as EntityId)}
    >
      {body}
    </button>
  ) : (
    <span className="tch-ledger-tree__row" data-testid="ledger-row" data-id={node.id} title={node.id}>
      {body}
    </span>
  );
}
