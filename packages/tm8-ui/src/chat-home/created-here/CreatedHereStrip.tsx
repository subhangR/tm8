/**
 * CREATED HERE — the thin strip on top of the chat composer (task 01a14a4a).
 *
 * It replaces the ledger panel's `sessions ⌃ · 0 sessions` bar. What it shows
 * is a SERVER fact, not a transcript fold: the roots this chat made
 * (`filters.createdIn`, migration 327), one kind at a time, each root
 * expandable to its whole subtree through the ordinary hierarchy. On a node
 * that predates 327 the reader falls back to the chat's spawned sessions and
 * this component unions the transcript's own creates on top, so the strip is
 * never emptier than what the conversation visibly did.
 *
 * THE SHAPE IS A FIELDSET (design ruling 2026-10-17): the strip IS a border
 * line, and the kind chips sit in it like a legend — `──[☑ 3][◉ 3]──── ● 2 ⌃`.
 * Collapsed, that line is all there is. Expanded, the tree hangs below it
 * inside the same frame. It is narrower than the composer so it reads as a tab
 * on it, and its height is capped with an internal scroll so the composer
 * never moves.
 *
 * Kinds appear only when this chat made a root of that kind; with none at all
 * the strip renders nothing. Open/closed and the selected kind are remembered
 * per chat. Rows update live from the workspace event stream.
 *
 * ROLLUP AND TAGS (task 01a14a91). What a session spawned from this chat made
 * is made here too: the server rolls it into `createdIn`, the strip hangs each
 * session's outputs under it, and a rolled-up root says `from <session>`. Any
 * other entity joins by a TAG — one `attached_to` edge, entity -> chat — that
 * a human adds with `+` (search, pick) and removes from the row, and that an
 * agent writes with `tm8 edge create <id> attached_to <chat>`. Tags and child
 * outputs land live from the edge events.
 */
import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent, type MouseEvent, type ReactElement } from 'react';
import type { DurableWorkspaceEvent, EntityId, EntitySummary } from '@tm8/contract';
import { KindIcon } from '../../domain/KindIcon';
import { getKind } from '../../domain/registry';
import { foldChatLedger, kindWord } from '../ledger';
import type { ChatTurn } from '../types';
import {
  ageOf,
  kindsOf,
  madeStatusOf,
  passesFilter,
  readMemory,
  rootsOf,
  sessionByline,
  summaryOf,
  writeMemory,
  type LivenessOf,
  type MadeFilter,
  type MadeMemory,
  type MadeStatus,
} from './created-here-model';
import type { ChatTag, CreatedHereReader } from './reader';
import './created-here.css';

/** Ids the transcript says this chat created, read one by one — capped. */
const LEDGER_READ_CAP = 40;
/** Children read ahead for drawn rows, so twisties and counts are honest. */
const PREFETCH_CAP = 60;
/** ⌥-click "expand all" stops here rather than walk an unbounded tree. */
const EXPAND_ALL_CAP = 400;
/** Search and the All/Running/Done filter appear past this many roots. */
const TOOLS_AT = 4;
const HIDDEN_CHILD_KINDS = new Set(['message', 'form']);
/** Sessions whose outputs are read up front, for the `from <session>` line. */
const OUTPUTS_CAP = 20;
/** The attach search waits this long after the last keystroke. */
const SEARCH_DEBOUNCE_MS = 200;

export interface CreatedHereStripProps {
  chatId: EntityId;
  spaceId: string;
  reader?: CreatedHereReader | undefined;
  /** The thread's turns — their creates are unioned in on pre-327 nodes. */
  turns?: readonly ChatTurn[] | undefined;
  livenessOf?: LivenessOf | undefined;
  /** Rows open here (the screen's right panel). Absent ⇒ rows are inert. */
  onOpenEntity?: ((id: EntityId) => void) | undefined;
  modelLabel?: ((model: string) => string) | undefined;
  storage?: Storage | null | undefined;
  now?: (() => number) | undefined;
}

type ChildState = readonly EntitySummary[] | 'loading' | 'failed';

interface AttachState {
  text: string;
  results: readonly EntitySummary[] | 'loading' | 'failed' | null;
  error: string | null;
}

function defaultStorage(): Storage | null {
  try {
    return typeof window === 'undefined' ? null : window.localStorage;
  } catch {
    return null;
  }
}

export function CreatedHereStrip({
  chatId,
  spaceId,
  reader,
  turns,
  livenessOf,
  onOpenEntity,
  modelLabel = (model) => model,
  storage,
  now = Date.now,
}: CreatedHereStripProps) {
  const store = storage === undefined ? defaultStorage() : storage;
  const [memory, setMemory] = useState<MadeMemory>(() => readMemory(chatId, store));
  const [serverRoots, setServerRoots] = useState<readonly EntitySummary[]>([]);
  const [ledgerReads, setLedgerReads] = useState<readonly EntitySummary[]>([]);
  const [children, setChildren] = useState<ReadonlyMap<string, ChildState>>(new Map());
  const [open, setOpen] = useState<ReadonlySet<string>>(new Set());
  const [search, setSearch] = useState('');
  const [filter, setFilter] = useState<MadeFilter>('all');
  const [peek, setPeek] = useState<{ id: string; lines: readonly { source: string; text: string }[] | 'loading' | 'failed' } | null>(null);
  const [compose, setCompose] = useState<{ id: string; draft: string; state: 'idle' | 'sending' | 'failed' } | null>(null);
  const [tags, setTags] = useState<readonly ChatTag[]>([]);
  const [outputs, setOutputs] = useState<ReadonlyMap<string, readonly EntitySummary[]>>(new Map());
  const [attach, setAttach] = useState<AttachState | null>(null);
  const childrenRef = useRef(children);
  childrenRef.current = children;
  const outputsAsked = useRef(new Set<string>());

  /* A new chat brings its own memory; nothing of the last one carries over. */
  useEffect(() => {
    setMemory(readMemory(chatId, store));
    setServerRoots([]);
    setLedgerReads([]);
    setChildren(new Map());
    setOpen(new Set());
    setSearch('');
    setFilter('all');
    setPeek(null);
    setCompose(null);
    setTags([]);
    setOutputs(new Map());
    setAttach(null);
    outputsAsked.current = new Set();
    // `store` is stable per mount; the chat id is what changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [chatId]);

  const remember = useCallback(
    (next: MadeMemory) => {
      setMemory(next);
      writeMemory(chatId, next, store);
    },
    [chatId, store],
  );

  /* ── reads ─────────────────────────────────────────────────────────── */
  const loadRoots = useCallback(async () => {
    if (!reader) return;
    try {
      const items = await reader.roots({ spaceId, chatId });
      setServerRoots(items);
    } catch {
      // A failed read keeps what was drawn; the next event retries.
    }
  }, [reader, spaceId, chatId]);

  useEffect(() => {
    void loadRoots();
  }, [loadRoots]);

  const loadTags = useCallback(async () => {
    if (!reader?.tags) return;
    try {
      setTags(await reader.tags(chatId));
    } catch {
      // Tags are additive; a failed read leaves the made roots alone.
    }
  }, [reader, chatId]);

  useEffect(() => {
    void loadTags();
  }, [loadTags]);

  const ledgerIds = useMemo(() => {
    if (!turns || turns.length === 0) return [] as string[];
    const ledger = foldChatLedger(turns);
    const created = new Set(ledger.creates.map((create) => create.id));
    return ledger.creates
      .filter((create) => {
        const parent = ledger.parentOf.get(create.id);
        return !parent || !created.has(parent);
      })
      .map((create) => create.id)
      .slice(0, LEDGER_READ_CAP);
  }, [turns]);
  const ledgerKey = ledgerIds.join(',');
  const knownKey = serverRoots.map((root) => root.id).join(',');

  useEffect(() => {
    const read = reader?.read;
    if (!read) return;
    const known = new Set(serverRoots.map((root) => root.id));
    const missing = ledgerIds.filter((id) => !known.has(id));
    if (missing.length === 0) return;
    let cancelled = false;
    void Promise.allSettled(missing.map((id) => read(id as EntityId))).then((results) => {
      if (cancelled) return;
      setLedgerReads(
        results.flatMap((result) => (result.status === 'fulfilled' ? [result.value] : [])),
      );
    });
    return () => {
      cancelled = true;
    };
    // The keys stand for the id lists; a re-read of the same roots reads nothing.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [reader, ledgerKey, knownKey]);

  const madeRoots = useMemo(() => rootsOf([...serverRoots, ...ledgerReads], chatId), [serverRoots, ledgerReads, chatId]);
  /* A tag is a root of its own kind, after what was made here. An entity both
     made here and tagged draws once, as made; its tag still removes. */
  const tagOf = useMemo(() => new Map(tags.map((tag) => [tag.entity.id, tag])), [tags]);
  const roots = useMemo(() => {
    const made = new Set(madeRoots.map((root) => root.id));
    const tagged = tags
      .map((tag) => tag.entity)
      .filter((entity) => !entity.deletedAt && entity.id !== chatId && !made.has(entity.id) && !HIDDEN_CHILD_KINDS.has(entity.kind));
    return [...madeRoots, ...tagged];
  }, [madeRoots, tags, chatId]);
  const kinds = useMemo(() => kindsOf(roots), [roots]);
  const kind = memory.kind && kinds.some((k) => k.kind === memory.kind) ? memory.kind : (kinds[0]?.kind ?? null);

  const loadChildren = useCallback(
    async (id: string): Promise<readonly EntitySummary[]> => {
      if (!reader) return [];
      const existing = childrenRef.current.get(id);
      if (Array.isArray(existing)) return existing as readonly EntitySummary[];
      setChildren((prev) => new Map(prev).set(id, 'loading'));
      try {
        const items = (await reader.children(id as EntityId)).filter((child) => !HIDDEN_CHILD_KINDS.has(child.kind));
        setChildren((prev) => new Map(prev).set(id, items));
        return items;
      } catch {
        setChildren((prev) => new Map(prev).set(id, 'failed'));
        return [];
      }
    },
    [reader],
  );

  /* What each spawned session made: its outputs hang under it, and a rolled-up
     root names the session it came from. Read once per session, capped. */
  const sessionRootKey = roots.filter((root) => root.kind === 'work_session').map((root) => root.id).slice(0, OUTPUTS_CAP).join(',');
  useEffect(() => {
    const read = reader?.outputs;
    if (!read || sessionRootKey === '') return;
    for (const id of sessionRootKey.split(',')) {
      if (outputsAsked.current.has(id)) continue;
      outputsAsked.current.add(id);
      void read(id as EntityId).then(
        (items) => setOutputs((prev) => new Map(prev).set(id, items)),
        () => undefined,
      );
    }
  }, [reader, sessionRootKey]);

  const sessionTitles = useMemo(
    () => new Map(roots.filter((root) => root.kind === 'work_session').map((root) => [root.id, root.title])),
    [roots],
  );
  const madeBy = useMemo(() => {
    const by = new Map<string, string>();
    for (const [session, items] of outputs) for (const item of items) if (!by.has(item.id)) by.set(item.id, session);
    return by;
  }, [outputs]);

  /* A session's rows are its hierarchy children plus what it made; an output
     whose parent is also listed stays in that parent's subtree. */
  const childrenOf = useCallback(
    (id: string): ChildState | undefined => {
      const kids = children.get(id);
      const outs = outputs.get(id);
      if (!outs || outs.length === 0) return kids;
      const listed = Array.isArray(kids) ? (kids as readonly EntitySummary[]) : [];
      const byId = new Map<string, EntitySummary>();
      for (const item of [...listed, ...outs]) if (!item.deletedAt && !byId.has(item.id)) byId.set(item.id, item);
      return [...byId.values()].filter((item) => item.parentId === id || !item.parentId || !byId.has(item.parentId));
    },
    [children, outputs],
  );

  /* ── live updates ──────────────────────────────────────────────────── */
  const refresh = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    const subscribe = reader?.subscribe;
    if (!subscribe) return;
    const scheduleRoots = () => {
      if (refresh.current) clearTimeout(refresh.current);
      refresh.current = setTimeout(() => void loadRoots(), 600);
    };
    const off = subscribe((event: DurableWorkspaceEvent) => {
      if (event.type === 'edge.upsert' || event.type === 'edge.deleted') {
        const { edge } = event;
        const removed = event.type === 'edge.deleted';
        if (edge.type === 'attached_to' && edge.target.id === chatId) {
          setTags((prev) => {
            const rest = prev.filter((tag) => tag.edgeId !== edge.id);
            return removed ? rest : [...rest, { edgeId: edge.id, entity: edge.source }];
          });
        } else if (edge.type === 'authored_from' && !HIDDEN_CHILD_KINDS.has(edge.source.kind)) {
          /* Something was made in this chat or in one of its sessions: the
             server decides whether it is a root here, and a session that is
             already drawn gains (or loses) the output under it. */
          setOutputs((prev) => {
            const list = prev.get(edge.target.id);
            if (!list) return prev;
            const rest = list.filter((item) => item.id !== edge.source.id);
            return new Map(prev).set(edge.target.id, removed ? rest : [...rest, edge.source]);
          });
          scheduleRoots();
        }
        return;
      }
      if (event.type !== 'entity.upsert' && event.type !== 'entity.deleted') return;
      const entity = event.entity;
      if (HIDDEN_CHILD_KINDS.has(entity.kind)) return;
      const patch = (list: readonly EntitySummary[]) =>
        list.some((item) => item.id === entity.id)
          ? list.map((item) => (item.id === entity.id ? entity : item))
          : list;
      setServerRoots((prev) => patch(prev));
      setLedgerReads((prev) => patch(prev));
      setTags((prev) =>
        prev.some((tag) => tag.entity.id === entity.id)
          ? prev.map((tag) => (tag.entity.id === entity.id ? { ...tag, entity } : tag))
          : prev,
      );
      setOutputs((prev) => {
        let next: Map<string, readonly EntitySummary[]> | null = null;
        for (const [session, list] of prev) {
          if (!list.some((item) => item.id === entity.id)) continue;
          next ??= new Map(prev);
          next.set(session, patch(list));
        }
        return next ?? prev;
      });
      setChildren((prev) => {
        let next: Map<string, ChildState> | null = null;
        for (const [parent, state] of prev) {
          if (!Array.isArray(state)) continue;
          const list = state as readonly EntitySummary[];
          const has = list.some((item) => item.id === entity.id);
          if (has || entity.parentId === parent) {
            next ??= new Map(prev);
            next.set(parent, has ? patch(list) : [...list, entity]);
          }
        }
        return next ?? prev;
      });
      /* Something new may have been made here: the parent is this chat, or
         an agent just created it. Re-asking the server is the only honest
         way to know — the event does not carry provenance. */
      const fresh = Date.now() - Date.parse(entity.createdAt) < 120_000;
      if (entity.parentId === chatId || (fresh && entity.createdBy.isAgent)) scheduleRoots();
    });
    return () => {
      off();
      if (refresh.current) clearTimeout(refresh.current);
    };
  }, [reader, loadRoots, chatId]);

  /* ── statuses ──────────────────────────────────────────────────────── */
  const statusOf = useCallback((summary: EntitySummary): MadeStatus => madeStatusOf(summary, livenessOf), [livenessOf]);
  const live = useMemo(() => summaryOf(roots.map(statusOf)), [roots, statusOf]);

  const kindRoots = useMemo(() => roots.filter((root) => root.kind === kind), [roots, kind]);
  const needle = search.trim().toLowerCase();
  const matches = useCallback(
    (summary: EntitySummary): boolean => {
      if (!needle) return true;
      if (summary.title.toLowerCase().includes(needle)) return true;
      const kids = childrenOf(summary.id);
      return Array.isArray(kids) && (kids as readonly EntitySummary[]).some(matches);
    },
    [needle, childrenOf],
  );
  const shownRoots = useMemo(
    () => kindRoots.filter((root) => passesFilter(statusOf(root), filter) && matches(root)),
    [kindRoots, statusOf, filter, matches],
  );

  /* Read one level ahead for every drawn row, so a twisty is drawn only where
     there is something under it and the count is a count, not a guess. */
  useEffect(() => {
    if (!memory.expanded || !reader) return;
    const drawn: string[] = [];
    const walk = (items: readonly EntitySummary[]) => {
      for (const item of items) {
        drawn.push(item.id);
        const kids = childrenOf(item.id);
        if (open.has(item.id) && Array.isArray(kids)) walk(kids as readonly EntitySummary[]);
      }
    };
    walk(shownRoots);
    const pending = drawn.filter((id) => !children.has(id)).slice(0, PREFETCH_CAP);
    for (const id of pending) void loadChildren(id);
  }, [memory.expanded, reader, shownRoots, open, children, childrenOf, loadChildren]);

  const toggleNode = useCallback(
    async (id: string, all: boolean) => {
      if (!all) {
        setOpen((prev) => {
          const next = new Set(prev);
          if (next.has(id)) next.delete(id);
          else next.add(id);
          return next;
        });
        void loadChildren(id);
        return;
      }
      /* ⌥-click: the whole subtree, breadth-first, bounded. */
      const opened = new Set<string>([id]);
      let frontier = [id];
      while (frontier.length > 0 && opened.size < EXPAND_ALL_CAP) {
        const levels = await Promise.all(frontier.map((node) => loadChildren(node)));
        frontier = levels.flat().map((child) => child.id).filter((child) => !opened.has(child));
        for (const child of frontier) opened.add(child);
      }
      setOpen((prev) => new Set([...prev, ...opened]));
    },
    [loadChildren],
  );

  const openPeek = useCallback(
    async (id: string) => {
      if (!reader?.peek) return;
      if (peek?.id === id) {
        setPeek(null);
        return;
      }
      setCompose(null);
      setPeek({ id, lines: 'loading' });
      try {
        const lines = await reader.peek(id as EntityId);
        setPeek((prev) => (prev?.id === id ? { id, lines } : prev));
      } catch {
        setPeek((prev) => (prev?.id === id ? { id, lines: 'failed' } : prev));
      }
    },
    [reader, peek],
  );

  const send = useCallback(async () => {
    if (!reader?.message || !compose || !compose.draft.trim() || compose.state === 'sending') return;
    const { id, draft } = compose;
    setCompose({ id, draft, state: 'sending' });
    try {
      await reader.message(id as EntityId, draft.trim());
      setCompose(null);
    } catch {
      setCompose({ id, draft, state: 'failed' });
    }
  }, [reader, compose]);

  /* ── tagging ───────────────────────────────────────────────────────── */
  const canAttach = Boolean(reader?.tag && reader?.search);
  const attachText = attach?.text.trim() ?? '';
  useEffect(() => {
    const search = reader?.search;
    if (!search || attachText === '') return;
    setAttach((prev) => (prev ? { ...prev, results: 'loading' } : prev));
    const timer = setTimeout(() => {
      search({ spaceId, text: attachText }).then(
        (items) => setAttach((prev) => (prev && prev.text.trim() === attachText ? { ...prev, results: items.filter((item) => item.id !== chatId) } : prev)),
        () => setAttach((prev) => (prev && prev.text.trim() === attachText ? { ...prev, results: 'failed' } : prev)),
      );
    }, SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [reader, spaceId, chatId, attachText]);

  const attachEntity = useCallback(
    async (entity: EntitySummary) => {
      if (!reader?.tag) return;
      try {
        const tag = await reader.tag(chatId, entity.id);
        if (tag) setTags((prev) => [...prev.filter((t) => t.edgeId !== tag.edgeId), tag]);
        else void loadTags();
        setAttach(null);
        remember({ kind: entity.kind, expanded: true });
      } catch (error) {
        const reason = error instanceof Error && error.message ? error.message : 'the server refused it';
        setAttach((prev) => (prev ? { ...prev, error: `Not attached: ${reason}` } : prev));
      }
    },
    [reader, chatId, loadTags, remember],
  );

  const removeTag = useCallback(
    async (tag: ChatTag) => {
      if (!reader?.untag) return;
      setTags((prev) => prev.filter((t) => t.edgeId !== tag.edgeId));
      try {
        await reader.untag(tag.edgeId);
      } catch {
        setTags((prev) => (prev.some((t) => t.edgeId === tag.edgeId) ? prev : [...prev, tag]));
      }
    },
    [reader],
  );

  const hasTurns = (turns?.length ?? 0) > 0;
  if (!reader) return null;
  if (roots.length === 0 && !(canAttach && (hasTurns || attach !== null))) return null;

  const expanded = memory.expanded;
  const nowMs = now();

  const renderRows = (items: readonly EntitySummary[], depth: number): ReactElement[] =>
    items.map((item) => {
      const status = statusOf(item);
      const kids = childrenOf(item.id);
      const list = Array.isArray(kids) ? (kids as readonly EntitySummary[]) : null;
      const hasKids = list ? list.length > 0 : kids === undefined || kids === 'loading';
      const isOpen = open.has(item.id) && hasKids;
      const from = depth === 0 ? madeBy.get(item.id) : undefined;
      const fromTitle = from ? sessionTitles.get(from) : undefined;
      const byline = sessionByline(item, modelLabel) ?? (fromTitle ? `from ${fromTitle}` : null);
      const isSession = item.kind === 'work_session';
      const tag = depth === 0 && reader.untag ? tagOf.get(item.id) : undefined;
      const twisty = (event: MouseEvent<HTMLButtonElement>) => {
        event.stopPropagation();
        void toggleNode(item.id, event.altKey);
      };
      const onRowKey = (event: KeyboardEvent<HTMLDivElement>) => {
        if (event.key === 'ArrowRight' && hasKids && !isOpen) void toggleNode(item.id, event.altKey);
        else if (event.key === 'ArrowLeft' && isOpen) void toggleNode(item.id, false);
        else if (event.key === 'Enter' && onOpenEntity) onOpenEntity(item.id);
        else return;
        event.preventDefault();
      };
      return (
        <li
          key={item.id}
          role="treeitem"
          aria-level={depth + 1}
          aria-expanded={hasKids ? isOpen : undefined}
          className="tch-made__node"
          data-testid="created-here-row"
          data-id={item.id}
        >
          <div
            className="tch-made__row"
            data-closed={status.closed || undefined}
            data-acts={isSession || tag !== undefined || undefined}
            style={{ paddingLeft: `calc(${depth} * var(--tch-made-indent))` }}
            tabIndex={0}
            onKeyDown={onRowKey}
          >
            {hasKids ? (
              <button
                type="button"
                className="tch-made__twisty"
                data-open={isOpen || undefined}
                aria-label={`${isOpen ? 'Collapse' : 'Expand'} ${item.title} (⌥-click expands everything under it)`}
                title="⌥-click expands everything under it"
                onClick={twisty}
              >
                <span aria-hidden>›</span>
              </button>
            ) : (
              <span className="tch-made__twisty" aria-hidden />
            )}
            <span
              className="tch-made__mark"
              data-mark={status.mark ?? 'none'}
              title={status.detail ?? status.word ?? undefined}
              aria-label={status.word ?? undefined}
              role={status.word ? 'img' : undefined}
            >
              {markGlyph(status.mark)}
            </span>
            {depth > 0 ? <KindIcon kind={item.kind} size={12} className="tch-made__kindmark" /> : null}
            <button
              type="button"
              className="tch-made__title"
              disabled={!onOpenEntity}
              title={item.title}
              onClick={() => onOpenEntity?.(item.id)}
            >
              {item.title || getKind(item.kind).label}
            </button>
            {byline ? <span className="tch-made__by">{byline}</span> : null}
            {tag ? <span className="tch-made__by" data-testid="created-here-tagged">tagged</span> : null}
            {list && list.length > 0 ? (
              <span className="tch-made__count" title={`${list.length} under it`}>{list.length}</span>
            ) : null}
            <span className="tch-made__age" title={item.createdAt}>{ageOf(item.createdAt, nowMs)}</span>
            {isSession ? (
              <span className="tch-made__acts">
                {reader.peek ? (
                  <button type="button" className="tch-made__act" onClick={() => void openPeek(item.id)} aria-pressed={peek?.id === item.id}>
                    Peek
                  </button>
                ) : null}
                {reader.message && !status.closed ? (
                  <button
                    type="button"
                    className="tch-made__act"
                    aria-pressed={compose?.id === item.id}
                    onClick={() => {
                      setPeek(null);
                      setCompose(compose?.id === item.id ? null : { id: item.id, draft: '', state: 'idle' });
                    }}
                  >
                    Message
                  </button>
                ) : null}
                {reader.stop && !status.closed ? (
                  <button
                    type="button"
                    className="tch-made__act tch-made__act--stop"
                    onClick={() => void reader.stop?.(item.id as EntityId).catch(() => undefined)}
                  >
                    Stop
                  </button>
                ) : null}
                {tag ? <UntagButton tag={tag} title={item.title} onRemove={removeTag} /> : null}
              </span>
            ) : tag ? (
              <span className="tch-made__acts">
                <UntagButton tag={tag} title={item.title} onRemove={removeTag} />
              </span>
            ) : null}
          </div>
          {peek?.id === item.id ? (
            <div className="tch-made__peek" style={{ marginLeft: `calc(${depth + 1} * var(--tch-made-indent))` }} data-testid="created-here-peek">
              {peek.lines === 'loading' ? <span className="tch-made__quiet">Reading…</span>
                : peek.lines === 'failed' ? <span className="tch-made__quiet">The transcript could not be read.</span>
                : peek.lines.length === 0 ? <span className="tch-made__quiet">Nothing written yet.</span>
                : peek.lines.map((line, index) => (
                  <p key={index} className="tch-made__peekline" data-source={line.source}>{line.text}</p>
                ))}
            </div>
          ) : null}
          {compose?.id === item.id ? (
            <form
              className="tch-made__compose"
              style={{ marginLeft: `calc(${depth + 1} * var(--tch-made-indent))` }}
              onSubmit={(event) => {
                event.preventDefault();
                void send();
              }}
            >
              <input
                className="tch-made__input"
                autoFocus
                value={compose.draft}
                placeholder={`Message ${item.title}`}
                aria-label={`Message ${item.title}`}
                readOnly={compose.state === 'sending'}
                onChange={(event) => setCompose({ ...compose, draft: event.target.value, state: 'idle' })}
                onKeyDown={(event) => {
                  if (event.key === 'Escape') setCompose(null);
                }}
              />
              {compose.state === 'failed' ? <span className="tch-made__quiet">Not sent</span> : null}
            </form>
          ) : null}
          {isOpen && list ? (
            <ul role="group" className="tch-made__tree">
              {renderRows(list.filter(matches), depth + 1)}
            </ul>
          ) : null}
        </li>
      );
    });

  return (
    <section
      className="tch-made"
      data-expanded={expanded || undefined}
      data-testid="created-here"
      aria-label="Created in this chat"
    >
      <div className="tch-made__rule">
        <div className="tch-made__kinds" role="tablist" aria-label="Kinds created here">
          {kinds.map((entry) => {
            const label = `${entry.count} ${kindWord(entry.kind, entry.count)}`;
            const selected = entry.kind === kind;
            return (
              <button
                key={entry.kind}
                type="button"
                role="tab"
                className="tch-made__kind"
                aria-selected={selected}
                aria-label={label}
                title={label}
                data-testid="created-here-kind"
                data-kind={entry.kind}
                onClick={() => remember({ kind: entry.kind, expanded: selected ? !expanded : true })}
              >
                <KindIcon kind={entry.kind} size={13} />
                <span className="tch-made__n">{entry.count}</span>
              </button>
            );
          })}
        </div>
        <span className="tch-made__gap" aria-hidden />
        {live.running > 0 || live.waiting > 0 ? (
          <span className="tch-made__live" data-testid="created-here-summary">
            {live.running > 0 ? (
              <span className="tch-made__running" title={`${live.running} running`}>
                <span className="tch-made__dot" aria-hidden /> {live.running} running
              </span>
            ) : null}
            {live.waiting > 0 ? (
              <span className="tch-made__waiting" title={`${live.waiting} waiting on you`}>
                <span aria-hidden>!</span> {live.waiting} waiting
              </span>
            ) : null}
          </span>
        ) : null}
        {canAttach ? (
          <button
            type="button"
            className="tch-made__attach"
            data-testid="created-here-attach"
            aria-expanded={attach !== null}
            aria-label="Attach an entity to this chat"
            title="Attach an entity to this chat"
            onClick={() => setAttach(attach ? null : { text: '', results: null, error: null })}
          >
            <span aria-hidden>+</span>
          </button>
        ) : null}
        {kind !== null ? (
        <button
          type="button"
          className="tch-made__toggle"
          data-testid="created-here-toggle"
          aria-expanded={expanded}
          aria-label={expanded ? 'Collapse what this chat created' : 'Expand what this chat created'}
          onClick={() => remember({ kind, expanded: !expanded })}
        >
          <span aria-hidden>⌃</span>
        </button>
        ) : null}
      </div>
      {attach ? (
        <div className="tch-made__attachbox" data-testid="created-here-attach-panel">
          <input
            className="tch-made__search"
            type="search"
            autoFocus
            value={attach.text}
            placeholder="Find an entity to attach"
            aria-label="Find an entity to attach to this chat"
            onChange={(event) => {
              const text = event.target.value;
              setAttach({ text, results: text.trim() ? attach.results : null, error: null });
            }}
            onKeyDown={(event) => {
              if (event.key === 'Escape') setAttach(null);
            }}
          />
          {attach.error ? <p className="tch-made__quiet" role="alert">{attach.error}</p> : null}
          {attach.results === 'loading' ? <p className="tch-made__quiet">Searching…</p>
            : attach.results === 'failed' ? <p className="tch-made__quiet">The search failed.</p>
            : attach.results && attach.results.length === 0 ? <p className="tch-made__quiet">Nothing found.</p>
            : attach.results ? (
              <ul className="tch-made__picks" aria-label="Entities to attach">
                {attach.results.map((entity) => {
                  const here = roots.some((root) => root.id === entity.id);
                  return (
                    <li key={entity.id}>
                      <button
                        type="button"
                        className="tch-made__pick"
                        data-testid="created-here-attach-result"
                        disabled={here}
                        title={here ? 'Already in this chat' : `Attach ${entity.title} to this chat`}
                        onClick={() => void attachEntity(entity)}
                      >
                        <KindIcon kind={entity.kind} size={12} className="tch-made__kindmark" />
                        <span className="tch-made__picktitle">{entity.title || getKind(entity.kind).label}</span>
                        {here ? <span className="tch-made__quiet">here</span> : null}
                      </button>
                    </li>
                  );
                })}
              </ul>
            ) : null}
        </div>
      ) : null}
      {expanded && kind !== null ? (
        <div className="tch-made__body" data-testid="created-here-body">
          {kindRoots.length >= TOOLS_AT ? (
            <div className="tch-made__tools">
              <input
                className="tch-made__search"
                type="search"
                value={search}
                placeholder={`Search ${kindWord(kind, 2)}`}
                aria-label={`Search ${kindWord(kind, 2)} created here`}
                onChange={(event) => setSearch(event.target.value)}
              />
              <span className="tch-made__filters" role="radiogroup" aria-label="Show">
                {(['all', 'running', 'done'] as const).map((value) => (
                  <button
                    key={value}
                    type="button"
                    role="radio"
                    aria-checked={filter === value}
                    className="tch-made__filter"
                    onClick={() => setFilter(value)}
                  >
                    {value === 'all' ? 'All' : value === 'running' ? 'Running' : 'Done'}
                  </button>
                ))}
              </span>
            </div>
          ) : null}
          {shownRoots.length === 0 ? (
            <p className="tch-made__quiet tch-made__empty">Nothing matches.</p>
          ) : (
            <ul className="tch-made__tree" role="tree" aria-label={`${kindWord(kind, 2)} created here`}>
              {renderRows(shownRoots, 0)}
            </ul>
          )}
        </div>
      ) : null}
    </section>
  );
}

function UntagButton({ tag, title, onRemove }: { tag: ChatTag; title: string; onRemove: (tag: ChatTag) => Promise<void> }) {
  return (
    <button
      type="button"
      className="tch-made__act"
      data-testid="created-here-untag"
      aria-label={`Remove ${title} from this chat`}
      title="Remove it from this chat (the entity stays)"
      onClick={() => void onRemove(tag)}
    >
      Remove
    </button>
  );
}

function markGlyph(mark: MadeStatus['mark']): string {
  switch (mark) {
    case 'running':
      return '●';
    case 'done':
      return '✓';
    case 'waiting':
      return '!';
    case 'failed':
      return '✕';
    case 'open':
      return '○';
    default:
      return '';
  }
}
