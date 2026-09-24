/**
 * CRAFT — the blueprint studio (Craft P1, task 01a00a31; design doc
 * 01a00a17-2d18 v2.1, rulings R1-R3).
 *
 * ONE HEADER, THREE REGIONS: the studio header names the blueprint, the
 * conversation about it, the view and the one committing verb; below it a
 * craft-mode chat on the left, ABOUT the selected `graph` entity (contextual
 * chat — `ChatCreateInput.aboutId`, written as an `about` edge by
 * `chat.start` — with the mode PINNED to 'craft'); the blueprint in the
 * middle, in the view the reader picked; and, when a node is selected, its
 * INSPECTOR on the right — which is also where an opened entity lands (it
 * replaces the inspector's body; never a fourth column).
 *
 * CHAT ↔ CANVAS: a node selected anywhere (canvas, outline, table, a finding)
 * is selected everywhere; "Ask about this" seeds the composer with a link to
 * the node; each agent patch is DIFFED against the previous fold and the
 * strip over the canvas says what changed, its entries selecting the nodes.
 * The canvas dispatches on `graphType` (R3): 'entity' draws the card
 * blueprint, 'mermaid' renders the diagram source through the same Mermaid
 * component docs use, and an unknown type says so honestly.
 *
 * LIVE BY EVENTS: the agent's guarded patches to the row arrive as durable
 * `entity.upsert` events; the canvas re-reads the row on each one. No
 * polling, no transcript folding — the ROW is the one source of truth (R1).
 *
 * ORCHESTRATE: the affordance posts the APPROVAL into the selected craft
 * thread — nothing more (R2: materialization is the agent's, and it begins
 * only when approval lands in-thread). Zero new catalog ops anywhere here:
 * list = collections.query, create = entities.create, approve =
 * messages.post.
 */
import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from 'react';

import { blueprintNodeRef, orchestrationNodeKind, ORCHESTRATION_NODE_KINDS, type EntityDetail, type EntityId, type EntitySummary, type SpaceId } from '@tm8/contract';
import type { Seam } from '../data/seam';
import { createChatHomePortFromSeam, type ChatHomeL2Bridge } from '../chat-home/real-port';
import { ChatHomeSurface } from '../chat-home/ChatHomeSurface';
import type { ChatThreadSummary } from '../chat-home/types';
import type { TriggerOption } from '../rich-input';
import { Mermaid } from '../kit/Mermaid';
import { PanelResizer, useElementWidth, usePanelWidth } from '../kit';
import { screenKeyOf, useScreenStack } from '../stores/screenStackStore';
import { blueprintView, nodeRefId } from './blueprint-model';
import type { BlueprintView, RefInfo, RefTitles } from './blueprint-types';
import { BlueprintCanvas } from './BlueprintCanvas';
import { BlueprintOutline } from './BlueprintOutline';
import { BlueprintTable } from './BlueprintTable';
import { CraftChatPicker } from './CraftChatPicker';
import { CraftChatIntro, CraftEmptyState } from './CraftEmptyState';
import { NodeInspector } from './NodeInspector';
import { FindingsChip, GraphPicker, OrchestrateButton, ViewSwitcher } from './StudioHeader';
import { diffBlueprintViews, isEmptyDiff, summarizeDiff, type BlueprintDiff } from './blueprint-diff';
import { availableViews, resolveView, type CraftViewId } from './presentation';
import { nodeByKey, titleOf } from './canvas-nav';
import { HostedEntityColumn } from '../views/hostedEntityColumn';
import type { CraftPanelHostProps } from './types';
import '../session-graph/session-graph.css';
import './craft.css';

export interface CraftScreenProps {
  seam: Seam;
  spaceId: SpaceId;
  nodeKey: string;
  bridge?: ChatHomeL2Bridge;
  skillOptions?: readonly TriggerOption[];
  viewerName?: string;
  viewerId?: string;
  /**
   * The shell bundle region C is built from. Present ⇒ a chip press opens
   * the entity in Craft's OWN third column, and the studio survives the
   * press; absent ⇒ there is no column and chips fall back to `onOpenEntity`.
   */
  panelHost?: CraftPanelHostProps;
  /**
   * The shell's entity-open verb — the FALLBACK route, used only when no
   * `panelHost` is supplied. The shell's version leaves Craft entirely
   * (it navigates to the workspace and unmounts this screen, taking the
   * selected graph, thread and glow baseline with it), which is why an
   * in-screen column is the better answer wherever one can be built.
   */
  onOpenEntity?: (id: EntityId) => void;
  onNotice?: (text: string) => void;
}

/** One frozen empty set, so "no selection" never mints a new identity. */
const EMPTY_ABOUT: ReadonlySet<EntityId> = new Set();

/** Set equality by membership — the only question `aboutSelected` is asked. */
function sameIds(current: ReadonlySet<EntityId>, next: readonly EntityId[]): boolean {
  return current.size === next.length && next.every((id) => current.has(id));
}

let craftSeq = 0;
const cmid = (tag: string) => `craft:${tag}:${Date.now()}:${(craftSeq += 1)}`;

/** The chat pane's default and floor. The floor is the composer's: narrower
 *  than this and the mode chip, agent select and Send wrap onto three rows. */
const CHAT_DEFAULT = 440;
const CHAT_MIN = 360;
/** The canvas keeps at least this much, so dragging can never erase it. */
const CANVAS_MIN = 320;
/** The inspector / region C column. Same numbers as every other reading column in the app. */
const DETAIL_DEFAULT = 380;
const DETAIL_MIN = 320;
/**
 * Below this studio width the inspector OVERLAYS the canvas's right edge
 * instead of taking width from it (coordinator ruling on the design audit):
 * three columns under ~1280px leave a canvas too narrow to read a flow in.
 */
const OVERLAY_BELOW = 1280;
/**
 * The separator track (8px) plus the aside's own 1px border — nothing in this
 * package sets `box-sizing: border-box` globally, so that border ADDS. Copied
 * from `ChannelView`'s `CHV_ASIDE_CHROME` for exactly the same reason.
 */
const PANE_CHROME = 8 + 1;

export function CraftScreen({
  seam,
  spaceId,
  nodeKey,
  bridge,
  skillOptions,
  viewerName,
  viewerId,
  panelHost,
  onOpenEntity,
  onNotice,
}: CraftScreenProps) {
  const [graphs, setGraphs] = useState<readonly EntitySummary[]>([]);
  const [selectedId, setSelectedId] = useState<EntityId | null>(null);
  const [detail, setDetail] = useState<EntityDetail | null>(null);
  const [loadState, setLoadState] = useState<'loading' | 'ready' | 'error'>('loading');
  const [refTitles, setRefTitles] = useState<RefTitles>(new Map());
  /**
   * The craft thread the approval posts into.
   *
   * Fed by the chat surface's RESOLVED selection (`onSelectionChange`), not
   * by its navigation report — so the cold-start auto-open counts. It has to:
   * the pane header names the open conversation, and a header captioned
   * "New craft conversation" above a plainly-loaded thread would be a lie
   * the viewer can see. Orchestrate reads the same value and is enabled a
   * little sooner for it, which is correct — an auto-opened thread IS open.
   */
  const [activeThreadId, setActiveThreadId] = useState<EntityId | null>(null);
  /**
   * What the PICKER asked for, handed down as `routeThreadId`. `undefined`
   * means "nothing asked yet" — the chat screen keeps its cold-start
   * auto-open; `null` is the explicit ＋ (the new-conversation composer).
   *
   * IT TRACKS THE RESOLVED SELECTION, and it has to. `routeThreadId` is
   * compared BY VALUE, while the chat screen moves its own selection when a
   * send creates a thread — so a request left naming the value it asked for
   * last goes stale the moment those two diverge, and re-asking for it is
   * then a no-op React drops before the adoption effect can see it. That is
   * not hypothetical: ＋ after a send left the request on `null` while the
   * screen sat in the new thread, and the button stopped working for the
   * rest of the session. A request that mirrors what is actually open can
   * always be moved away from.
   */
  const [requestedThreadId, setRequestedThreadId] = useState<EntityId | null | undefined>(undefined);
  /** The conversation list, published up by the chat screen's ONE read. */
  const [threads, setThreads] = useState<readonly ChatThreadSummary[]>([]);
  const [approving, setApproving] = useState(false);
  /**
   * What the LATEST agent patch changed, diffed against the previous fold of
   * the same row. Durable until the next patch or a dismiss — the old 2.6s
   * glow was motion nobody could read back after looking away.
   */
  const [lastDiff, setLastDiff] = useState<BlueprintDiff | null>(null);
  const prevViewRef = useRef<{ id: EntityId; version: number; view: BlueprintView } | null>(null);
  const selectedRef = useRef<EntityId | null>(null);
  selectedRef.current = selectedId;
  /** The selected NODE (row-local key) — one selection shared by every view and the inspector. */
  const [pickedNode, setNodeKey] = useState<string | null>(null);
  const [viewChoice, setViewChoice] = useState<CraftViewId>('flow');
  const [chatCollapsed, setChatCollapsed] = useState(false);
  const [composerSeed, setComposerSeed] = useState<{ text: string; nonce: number } | undefined>(undefined);

  const refreshList = useCallback(async () => {
    const result = await seam.query({ spaceId, kinds: ['graph'], sort: 'activityAt_desc', limit: 50 });
    setGraphs(result.page.items);
    /* A studio with nothing selected adopts the first graph that exists —
       the crafted-from-chat row appears without a manual pick. */
    const first = result.page.items[0]?.id as EntityId | undefined;
    if (first !== undefined && selectedRef.current === null) setSelectedId(first);
    return result.page.items;
  }, [seam, spaceId]);

  const readRow = useCallback(
    async (id: EntityId) => {
      try {
        const row = await seam.entity(id);
        /* Guard a stale settle: the read that matters is the selected row's. */
        if (selectedRef.current === id) {
          setDetail(row);
          setLoadState('ready');
        }
      } catch {
        if (selectedRef.current === id) setLoadState('error');
      }
    },
    [seam],
  );

  /* Hydrate: list, then select the most recent graph (if any). */
  useEffect(() => {
    let alive = true;
    setLoadState('loading');
    refreshList()
      .then((items) => {
        if (!alive) return;
        setSelectedId((current) => current ?? ((items[0]?.id as EntityId | undefined) ?? null));
        if (items.length === 0) setLoadState('ready');
      })
      .catch(() => alive && setLoadState('error'));
    return () => {
      alive = false;
    };
  }, [refreshList]);

  /* The selected row's read, and the switch reset. */
  useEffect(() => {
    setActiveThreadId(null);
    setNodeKey(null);
    setLastDiff(null);
    if (!selectedId) {
      setDetail(null);
      return;
    }
    setLoadState('loading');
    void readRow(selectedId);
  }, [selectedId, readRow]);

  /**
   * SWITCHING BLUEPRINTS SWITCHES CONVERSATIONS, because the two headers
   * claim to be one hierarchy: this graph, and the chats about it. Landing on
   * the space's most recent thread — which is what the chat screen's own
   * cold-start would do — could easily belong to a different blueprint, and
   * the header would then name a conversation the canvas has nothing to do
   * with. No craft thread on this graph yet ⇒ the composer, which is the
   * honest place to start one.
   *
   * IT WAITS FOR THE LIST. Resolving against an empty `threads` would answer
   * "no conversation here" before anything had been read, and the answer
   * would stick — so an unresolved graph re-tries on each publish. A space
   * with genuinely no threads never resolves and never needs to: the chat
   * screen has nothing to auto-open either, and both land on the composer.
   */
  /* The SAME port `ChatHomeSurface` builds from this seam — `createChatHomePortFromSeam`
     is a pure factory over it, so this is one construction, not a second
     reader with its own cache. */
  const port = useMemo(() => createChatHomePortFromSeam(seam, bridge), [seam, bridge]);

  /**
   * WHICH CHATS ARE ABOUT THE SELECTED BLUEPRINT — ONE READ, asked of the
   * blueprint rather than of every chat.
   *
   * The filter used to be `thread.anchorId === selectedId`, and that field was
   * filled by `listThreads` paying one `entities.connections` call PER CHAT to
   * discover each one's subject: a documented N+1 on the space-wide read,
   * carried by every host of the chat surface to serve this one picker. The
   * edge is chat → subject, so its INCOMING side on the blueprint answers for
   * all of them at once, and only Craft — the only surface that scopes by
   * subject — pays for it.
   *
   * RE-RUN WHEN THE THREAD LIST'S MEMBERSHIP CHANGES, deliberately: a send
   * that creates a craft chat writes a new `about` edge, and the list publish
   * is the signal that it happened. Keyed on the ROOT IDS rather than on the
   * `threads` array, because that array's identity changes on every publish
   * including ones that changed nothing.
   *
   * AND IT SETTLES RATHER THAN RE-SETTING. An unconditional `setAboutSelected`
   * re-renders this screen on every publish, and the canvas's freshness diff
   * (below) is render-order sensitive: measured, the extra render made
   * `craft-screen.test.tsx > renders the ROW on the canvas` fail about one run
   * in three — a real nondeterminism this screen did not have before, not a
   * pre-existing flake. Writing only on a genuine change removes it.
   *
   * An empty set before the read lands is not "no chats"; the effect below
   * waits for `threads` for the same reason.
   */
  const [aboutSelected, setAboutSelected] = useState<ReadonlySet<EntityId>>(EMPTY_ABOUT);
  const threadKey = threads.map((thread) => thread.rootId).join(',');
  useEffect(() => {
    if (!selectedId) {
      setAboutSelected((current) => (current.size === 0 ? current : EMPTY_ABOUT));
      return;
    }
    let live = true;
    void port.chatIdsAbout(selectedId).then((ids) => {
      if (!live) return;
      setAboutSelected((current) => (sameIds(current, ids) ? current : new Set(ids)));
    });
    return () => { live = false; };
  }, [port, selectedId, threadKey]);

  const resolvedForRef = useRef<EntityId | null>(null);
  useEffect(() => {
    if (!selectedId || resolvedForRef.current === selectedId) return;
    if (threads.length === 0) return;
    resolvedForRef.current = selectedId;
    const scoped = threads.filter(
      (thread) => thread.config.mode === 'craft' && aboutSelected.has(thread.rootId),
    );
    setRequestedThreadId(scoped[0]?.rootId ?? null);
  }, [selectedId, threads, aboutSelected]);

  /**
   * THE RESOLVED SELECTION, ADOPTED — the header's subject and the request
   * move together.
   *
   * The chat screen is not only steered; it also STEERS ITSELF, and the send
   * that turns the composer into a real thread is the case that matters.
   * Recording that in `requestedThreadId` too is what keeps ＋ and the picker
   * able to move away from wherever the screen actually landed. Both writes
   * are no-ops when nothing changed, so this cannot cycle with the publish
   * effect that calls it.
   */
  /**
   * THE HOST DRIVING ITS OWN SELECTION — the picker's rows and ＋.
   *
   * BOTH HALVES MOVE HERE, and that is not a duplicate of `adoptSelection`
   * below. The chat screen SUPPRESSES its selection publish when the thread it
   * resolved is the one the host just pushed down (the echo guard in
   * `ChatHomeScreen`), so a host-driven change is exactly the case that never
   * comes back — and `activeThreadId` is what the picker reads for its label.
   *
   * Setting only `requestedThreadId` therefore steered the chat correctly and
   * left the picker naming the thread it had just left: ＋ opened the composer
   * while the row above it still said "Draft the blueprint.". Waiting for the
   * echo cannot fix that, because the echo is deliberately not sent.
   */
  const requestThread = useCallback((id: EntityId | null) => {
    setRequestedThreadId(id);
    setActiveThreadId(id);
  }, []);

  const adoptSelection = useCallback((id: EntityId | null) => {
    setActiveThreadId(id);
    /* `undefined` is left alone. It means "nothing asked yet", and the mount
       publishes a null selection before anything has been read — collapsing
       that to an explicit `null` would forbid the chat's cold-start auto-open
       before the blueprint resolve above has had its say. */
    setRequestedThreadId((asked) => (asked === undefined ? asked : id));
  }, []);

  /* LIVE: a durable entity event for the selected row re-reads it; any graph
     upsert refreshes the picker (a rename, a new blueprint from chat). */
  useEffect(() => {
    return seam.onEvent((event) => {
      if (event.type !== 'entity.upsert' && event.type !== 'entity.deleted') return;
      if (event.entity.kind !== 'graph') return;
      void refreshList();
      if (event.entity.id === selectedRef.current) {
        if (event.type === 'entity.deleted') setSelectedId(null);
        else void readRow(event.entity.id as EntityId);
      }
    });
  }, [seam, refreshList, readRow]);

  /* Resolve reference-node titles the row names (bounded, cached by id). */
  const content = detail?.content;
  useEffect(() => {
    if (!content || (content as { kind?: string }).kind !== 'graph') return;
    /* Resolve through the SAME pin the canvas folds with (`nodeRefId`): a spec's
       row-local key is not an entity id, and fetching it was what printed
       "unavailable entity" on every spec card. */
    const nodes = (content as { nodes?: Parameters<typeof nodeRefId>[0][] }).nodes ?? [];
    const wanted = [...new Set(nodes.map((node) => nodeRefId(node)).filter((id): id is EntityId => id !== null))]
      .filter((id) => !refTitles.has(id))
      .slice(0, 24);
    if (wanted.length === 0) return;
    let alive = true;
    void Promise.allSettled(wanted.map((id) => seam.entity(id as EntityId))).then((settled) => {
      if (!alive) return;
      setRefTitles((current) => {
        const next = new Map(current);
        settled.forEach((result, index) => {
          const id = wanted[index];
          if (!id) return;
          if (result.status === 'fulfilled') {
            next.set(id, refInfoOf(result.value));
          } else {
            /* Honestly marked: the row references something this read cannot see. */
            next.set(id, { kind: 'entity', title: 'unavailable entity' });
          }
        });
        return next;
      });
    });
    return () => {
      alive = false;
    };
  }, [content, refTitles, seam]);

  /* THE LIVE MAP: after Orchestrate the references are real tasks whose
     status moves. A durable upsert for an entity the blueprint references
     re-reads just that one, so the card's stripe and pulse follow it. */
  const refIdsRef = useRef(refTitles);
  refIdsRef.current = refTitles;
  useEffect(() => {
    return seam.onEvent((event) => {
      if (event.type !== 'entity.upsert') return;
      const id = event.entity.id as EntityId;
      if (!refIdsRef.current.has(id)) return;
      void seam.entity(id).then(
        (entity) => setRefTitles((current) => new Map(current).set(id, refInfoOf(entity))),
        () => undefined,
      );
    });
  }, [seam]);

  const createGraph = useCallback(async () => {
    try {
      const result = await seam.commands.createEntity({
        clientMutationId: cmid('new'),
        spaceId,
        kind: 'graph',
        title: 'Untitled graph',
        content: { graphType: 'entity' },
      });
      await refreshList();
      const id = result.entity?.id as EntityId | undefined;
      if (id) setSelectedId(id);
    } catch (error) {
      onNotice?.(error instanceof Error ? error.message : 'Could not create the graph.');
    }
  }, [seam, spaceId, refreshList, onNotice]);

  const approveOrchestrate = useCallback(async () => {
    if (!selectedId || !activeThreadId || approving) return;
    setApproving(true);
    try {
      /* The whole affordance (design §4): approval lands IN the thread; the
         craft agent materializes from there via existing delegation. */
      await seam.commands.postMessage({
        clientMutationId: cmid('approve'),
        anchorIds: [selectedId],
        parentMessageId: activeThreadId,
        body: 'Approved — orchestrate this blueprint.',
      });
      onNotice?.('Approval posted into the craft thread.');
    } catch (error) {
      onNotice?.(error instanceof Error ? error.message : 'Could not post the approval.');
    } finally {
      setApproving(false);
    }
  }, [selectedId, activeThreadId, approving, seam, onNotice]);

  /* Lanes is the only view that changes the LAYOUT (swimlanes); Outline and
     Table read `lists`, which are layout-independent, from the flow fold. */
  const view = useMemo(
    () => (content && (content as { kind?: string }).kind === 'graph'
      ? blueprintView(content, refTitles, { mode: viewChoice === 'lanes' ? 'swimlane' : 'flow' })
      : null),
    [content, refTitles, viewChoice],
  );
  const viewId: CraftViewId = view ? resolveView(viewChoice, view) : 'flow';
  const selectedNode = view && pickedNode && nodeByKey(view, pickedNode) ? pickedNode : null;

  /**
   * THE WIDTH SOLVER. `usePanelWidth` holds what the viewer ASKED FOR,
   * unclamped, so narrowing the window once cannot overwrite the preference
   * (see its docblock); this screen clamps for PAINT, because it is the one
   * holding the measurement. `maxWidth` is measured rather than assumed — the
   * shell's own rail is variable, so the space available here is not a
   * function of the window.
   */
  const splitRef = useRef<HTMLDivElement | null>(null);
  const splitWidth = useElementWidth(splitRef);
  const { width: askedWidth, setWidth: setChatWidth, reset: resetChatWidth } = usePanelWidth(
    'craft.chat',
    CHAT_DEFAULT,
    CHAT_MIN,
  );
  const detailPref = usePanelWidth('craft.inspector', DETAIL_DEFAULT, DETAIL_MIN);

  /**
   * REGION C — the entity a chip opened.
   *
   * In the screen stack, NOT in `useState`: the rail unmounts Craft whenever
   * the viewer looks at another screen, and a local cell would drop the open
   * entity on the way out and back. Keyed by the view, which is what
   * `screenKeyOf.view` exists for.
   */
  const screen = useScreenStack(screenKeyOf.view('craft'));
  const canHostPanel = panelHost !== undefined;
  const detailId = canHostPanel ? screen.selected : null;
  /* The right column is open for an opened entity OR a selected node, and it
     OVERLAYS the canvas below the breakpoint rather than taking its width. */
  const sideOpen = detailId !== null || selectedNode !== null;
  const overlay = splitWidth > 0 && splitWidth < OVERLAY_BELOW;

  /* Region C's room comes out of the split BEFORE the chat's ceiling is
     computed, or a wide chat plus an open panel would leave the canvas below
     its floor — the three-region arithmetic EntityView spells out. */
  const detailMax = splitWidth > 0
    ? Math.max(DETAIL_MIN, splitWidth - CHAT_MIN - CANVAS_MIN - PANE_CHROME * 2)
    : Number.POSITIVE_INFINITY;
  const detailWidth = Math.min(Math.max(DETAIL_MIN, detailPref.width), detailMax);
  const detailRoom = sideOpen && !overlay ? detailWidth + PANE_CHROME : 0;
  /* Before the first measurement there is no honest ceiling, so the asked-for
     width paints as-is rather than being clamped against a zero. */
  const chatMax = splitWidth > 0
    ? Math.max(CHAT_MIN, splitWidth - CANVAS_MIN - PANE_CHROME - detailRoom)
    : Number.POSITIVE_INFINITY;
  const chatWidth = Math.min(Math.max(CHAT_MIN, askedWidth), chatMax);

  /**
   * A CHIP PRESS LANDS IN REGION C when the shell gave us one to land in, and
   * leaves the screen only when it did not. The blueprint cards and every
   * chat chip converge on this one verb.
   */
  const openEntity = useCallback(
    (id: EntityId) => {
      if (canHostPanel) screen.open(id);
      else onOpenEntity?.(id);
    },
    [canHostPanel, screen, onOpenEntity],
  );

  /* ESC CLOSES THE COLUMN — one rung at a time, and only ours: an opened
     entity first (back to the inspector), then the inspector. `defaultPrevented`
     keeps a dialog, a popover or the canvas's own Escape ahead of us. */
  useEffect(() => {
    if (!sideOpen) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || event.defaultPrevented) return;
      event.preventDefault();
      if (detailId) screen.pop();
      else setNodeKey(null);
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [sideOpen, detailId, screen]);

  /* WHAT THE PATCH CHANGED: diff consecutive folds of the SAME row. Switching
     graphs resets the baseline so a freshly opened blueprint does not arrive
     "changed" wholesale; a fold that changed nothing (a re-read, a view
     switch) leaves the last diff standing. */
  /* Keyed on the ROW VERSION, not on the fold: resolving a reference's title
     re-folds the view too, and "4f8c2a9e… → Session tree guide lines" is the
     host catching up, not the agent changing the plan. */
  const rowVersion = detail?.version ?? null;
  useEffect(() => {
    if (!view || !selectedId || rowVersion === null) return;
    const prev = prevViewRef.current;
    if (prev && prev.id === selectedId && prev.version === rowVersion) {
      prevViewRef.current = { ...prev, view };
      return;
    }
    prevViewRef.current = { id: selectedId, version: rowVersion, view };
    if (!prev || prev.id !== selectedId) return;
    const diff = diffBlueprintViews(prev.view, view);
    if (!isEmptyDiff(diff)) setLastDiff(diff);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rowVersion, selectedId, view]);

  const selectNode = useCallback((key: string | null) => {
    setNodeKey(key);
    if (key !== null) screen.clear();
  }, [screen]);

  /* "Ask about this": a link to the node, in the one spelling the craft
     prompt teaches (`blueprintNodeRef`, @tm8/contract). */
  const askAbout = useCallback((key: string) => {
    if (!view || !selectedId) return;
    setChatCollapsed(false);
    setComposerSeed((was) => ({
      text: blueprintNodeRef(selectedId, key, titleOf(view, key)),
      nonce: (was?.nonce ?? 0) + 1,
    }));
  }, [view, selectedId]);

  const seedPrompt = useCallback((text: string) => {
    setChatCollapsed(false);
    setComposerSeed((was) => ({ text, nonce: (was?.nonce ?? 0) + 1 }));
  }, []);

  /**
   * What Orchestrate would do with the specs. Only MATERIALIZABLE, rank-placed
   * kinds are "created". Teammates (attach-placed) and kinds the orchestrator
   * never creates (skills, people) are listed BY NAME as things the human
   * confirms — the craft prompt says teammate specs are proposals, and a
   * pre-flight that promised to create them would be the canvas contradicting
   * the agent.
   */
  const plan = useMemo(() => {
    const create: [string, number][] = [];
    const confirm: { label: string; names: string[] }[] = [];
    if (!view) return { create, confirm };
    const counts = new Map<string, number>();
    const toConfirm = new Map<string, string[]>();
    const note = (kind: string, label: string, title: string) => {
      const def = orchestrationNodeKind(kind);
      if (def && def.materializable && def.placement === 'rank') {
        counts.set(label, (counts.get(label) ?? 0) + 1);
      } else {
        toConfirm.set(label, [...(toConfirm.get(label) ?? []), title]);
      }
    };
    view.cards.filter((card) => card.isSpec).forEach((card) => note(card.kind, card.kindLabel, card.title));
    view.attached.filter((node) => node.isSpec)
      .forEach((node) => note(node.kind, orchestrationNodeKind(node.kind)?.label ?? 'Teammate', node.title));
    const plural = (label: string, n: number) => (n === 1 ? label : orchestrationNodeKindPlural(label));
    counts.forEach((n, label) => create.push([plural(label, n), n]));
    toConfirm.forEach((names, label) => confirm.push({ label: plural(label, names.length), names }));
    return { create, confirm };
  }, [view]);

  const isEntityGraph = view?.graphType === 'entity';
  const viewOptions = view && isEntityGraph && view.cards.length > 0 ? availableViews(view) : [];
  const findings = isEntityGraph && view ? view.findings : [];
  const orchestrateBlocked = !selectedId
    ? 'Select a blueprint first.'
    : !view || view.cards.length === 0
      ? 'The blueprint is empty — ask the chat to draft it first.'
      : !activeThreadId
        ? 'Open or start a craft conversation first — the approval posts into it.'
        : null;
  const marked = lastDiff ? { cards: lastDiff.marked, lines: lastDiff.markedLines } : undefined;
  const describedBy = 'crf-canvas-help';

  return (
    <div className="crf-root" data-testid="craft-screen">
      {/* ONE HEADER for the studio: which plan › which conversation, how to
          look at it, and the one committing verb. It replaced two pane
          headers that each carried an unrelated picker and a ＋. */}
      <header className="crf-head" data-testid="crf-head">
        <button
          type="button"
          className="crf-head__chat"
          data-testid="crf-chat-toggle"
          aria-pressed={!chatCollapsed}
          aria-controls="crf-chat-pane"
          title={chatCollapsed ? 'Show the conversation' : 'Hide the conversation'}
          onClick={() => setChatCollapsed((was) => !was)}
        >
          <svg width={16} height={16} viewBox="0 0 16 16" aria-hidden>
            <rect x={1.5} y={2.5} width={13} height={11} rx={2} />
            <path d={chatCollapsed ? 'M6 2.5 V13.5' : 'M6 2.5 V13.5 M2 5 H5 M2 7.5 H5'} />
          </svg>
        </button>
        <GraphPicker
          graphs={graphs}
          selectedId={selectedId}
          onSelect={(id) => setSelectedId(id)}
          onCreate={() => void createGraph()}
        />
        <span className="crf-head__sep" aria-hidden>›</span>
        <CraftChatPicker
          threads={threads}
          aboutSelected={aboutSelected}
          selectedId={activeThreadId}
          onSelect={requestThread}
          onNewChat={() => {
            setChatCollapsed(false);
            requestThread(null);
          }}
        />
        <span className="crf-head__fill" />
        <ViewSwitcher options={viewOptions} value={viewId} onChange={setViewChoice} />
        <FindingsChip
          findings={findings}
          onClick={() => {
            const first = findings.find((finding) => finding.nodes.length > 0);
            if (first) selectNode(first.nodes[0]!);
          }}
        />
        <OrchestrateButton
          findings={findings}
          plan={plan.create}
          confirm={plan.confirm}
          disabledReason={orchestrateBlocked}
          approving={approving}
          onApprove={() => void approveOrchestrate()}
          onShowNode={(key) => selectNode(key)}
        />
      </header>
      <div
        className={['crf-split', ...(overlay ? ['crf-split--overlay'] : [])].join(' ')}
        ref={splitRef}
        style={{ '--crf-chat': `${chatWidth}px`, '--crf-detail': `${detailWidth}px` } as CSSProperties}
      >
        <section className="crf-chat" id="crf-chat-pane" aria-label="Craft conversation" hidden={chatCollapsed}>
          <div className="crf-chat__body">
            <ChatHomeSurface
              seam={seam}
              spaceId={spaceId}
              nodeKey={nodeKey}
              bridge={bridge}
              /* Contextual chat: a new thread here is ABOUT the blueprint row,
                 written as an `about` edge by `chat.start`. No graph selected
                 yet ⇒ no subject, which is bare Home's shape.

                 THE PROP WAS `anchorId` AND NOTHING READ IT. Wave 1 renamed
                 `ChatHomeSurfaceProps.anchorId` to `aboutId` with the model
                 underneath it, and this spread kept the old key — a JSX spread
                 of a conditional expression gets no excess-property check, so
                 it compiled and silently dropped the subject. Every craft chat
                 started since has had no `about` edge. */
              {...(selectedId ? { aboutId: selectedId } : {})}
              pinnedMode="craft"
              composerSeed={composerSeed}
              newThreadIntro={<CraftChatIntro onPrompt={seedPrompt} />}
              skillOptions={skillOptions}
              onOpenEntity={openEntity}
              /* The thread column is this screen's, drawn as the header's
                 conversation crumb. `routeThreadId` is authoritative in solo mode. */
              soloConversation
              routeThreadId={requestedThreadId}
              onThreadsChange={setThreads}
              onSelectionChange={adoptSelection}
              viewerName={viewerName}
              viewerId={viewerId}
            />
          </div>
        </section>
        {/* The floor is the CANVAS's, measured — see `chatMax`. A handle that
            could drag the blueprint to nothing would be the zero-floored
            track the layout law forbids. */}
        {chatCollapsed ? null : (
          <PanelResizer
            side="left"
            label="Craft conversation"
            controls="crf-chat-pane"
            width={chatWidth}
            minWidth={CHAT_MIN}
            maxWidth={chatMax}
            onResize={setChatWidth}
            onReset={resetChatWidth}
          />
        )}
        <section className="crf-canvas" aria-label="Blueprint" data-testid="crf-canvas-pane">
          {lastDiff && isEntityGraph ? (
            <DiffStrip
              diff={lastDiff}
              view={view!}
              onSelect={selectNode}
              onDismiss={() => setLastDiff(null)}
            />
          ) : null}
          <div className="crf-canvas__body">
            {loadState === 'error' ? (
              <p className="crf-empty">This blueprint could not be read. Pick another from the header, or retry.</p>
            ) : !selectedId ? (
              loadState === 'loading' ? (
                <p className="crf-empty" role="status">Loading blueprints…</p>
              ) : (
                <CraftEmptyState hasGraph={false} onPrompt={seedPrompt} onCreate={() => void createGraph()} />
              )
            ) : !view ? (
              <p className="crf-empty" role="status">Loading the blueprint…</p>
            ) : view.graphType === 'mermaid' ? (
              view.source ? (
                <div className="crf-mermaid" data-testid="crf-mermaid">
                  <Mermaid source={view.source} testId="crf-mermaid-svg" />
                </div>
              ) : (
                <p className="crf-empty">A mermaid graph with no source yet — ask the chat to sketch one.</p>
              )
            ) : view.graphType === 'entity' ? (
              view.cards.length === 0 ? (
                <CraftEmptyState hasGraph onPrompt={seedPrompt} />
              ) : (
                <>
                  <p id={describedBy} className="crf-sr">
                    Arrow keys move between nodes, Enter inspects the selected node, f finds, 0 fits the whole plan,
                    and full stop focuses a node&apos;s neighbourhood. The Outline and Table views list the same blueprint as text.
                  </p>
                  {viewId === 'outline' ? (
                    <div className="crf-scroll">
                      <BlueprintOutline
                        view={view}
                        selectedKey={selectedNode}
                        onSelect={selectNode}
                        marked={lastDiff?.marked}
                      />
                    </div>
                  ) : viewId === 'table' ? (
                    <div className="crf-scroll">
                      <BlueprintTable
                        view={view}
                        selectedKey={selectedNode}
                        onSelect={selectNode}
                        marked={lastDiff?.marked}
                      />
                    </div>
                  ) : (
                    <BlueprintCanvas
                      /* A new blueprint or a new layout gets a fresh camera. */
                      key={`${selectedId}:${viewId}`}
                      view={view}
                      ariaLabel={`Blueprint ${detail?.title ?? ''}: ${view.cards.length} nodes, ${view.lines.length} edges`}
                      describedBy={describedBy}
                      selectedKey={selectedNode}
                      onSelect={selectNode}
                      marked={marked}
                    />
                  )}
                </>
              )
            ) : (
              <p className="crf-empty" data-testid="crf-unknown-type">
                {`Graph type “${view.graphType}” has no renderer in this build — the row is intact; a future type renders here.`}
              </p>
            )}
          </div>
        </section>
        {/*
          THE RIGHT COLUMN — the selected node's inspector, or the entity an
          "Open entity" / chat chip opened, which REPLACES the inspector's body
          (with a back arrow to it) rather than opening a fourth column.
          Rendered ONLY while something is open: an aside kept at
          `display:none` would still mount that entity's panel behind an
          invisible region, which is the rule `EntityView` states and obeys.
        */}
        {sideOpen && (selectedNode || (detailId && panelHost)) ? (
          <>
            {overlay ? null : (
              <PanelResizer
                side="right"
                label="Inspector"
                controls="crf-detail-pane"
                width={detailWidth}
                minWidth={DETAIL_MIN}
                maxWidth={detailMax}
                onResize={detailPref.setWidth}
                onReset={detailPref.reset}
              />
            )}
            <aside
              className="crf-detail"
              id="crf-detail-pane"
              aria-label={detailId ? 'Entity details' : 'Node inspector'}
              data-testid="crf-detail"
              data-overlay={overlay || undefined}
            >
              {detailId && panelHost ? (
                <>
                  {selectedNode ? (
                    <button type="button" className="crf-back" data-testid="crf-back" onClick={() => screen.clear()}>
                      <span aria-hidden>‹</span> Back to the node
                    </button>
                  ) : null}
                  <div className="crf-detail__entity">
                    <HostedEntityColumn
                      {...panelHost}
                      entityId={detailId}
                      /* Drilling REPLACES this column's subject — never a fourth. */
                      onOpenEntity={(id) => screen.open(id)}
                      onClose={() => screen.clear()}
                    />
                  </div>
                </>
              ) : view && selectedNode ? (
                <NodeInspector
                  view={view}
                  selectedKey={selectedNode}
                  onSelect={selectNode}
                  onOpenEntity={openEntity}
                  onAsk={askAbout}
                  onClose={() => setNodeKey(null)}
                />
              ) : null}
            </aside>
          </>
        ) : null}
      </div>
    </div>
  );
}

/** The live overlay a reference node carries: its status, and whether a session is on it now. */
function refInfoOf(entity: EntityDetail): RefInfo {
  const state = entity.state as { kind?: string; status?: string } | undefined;
  return {
    kind: entity.kind,
    title: entity.title,
    status: state && typeof state.status === 'string' ? state.status : null,
    live: (entity.badges?.workingActors?.length ?? 0) > 0,
  };
}

/**
 * THE DIFF STRIP — what the latest agent patch changed, over the canvas. The
 * entries are buttons that select the node (and so open the inspector), so
 * "the agent added Draft API spec" is one press from seeing it.
 */
function DiffStrip({
  diff,
  view,
  onSelect,
  onDismiss,
}: {
  diff: BlueprintDiff;
  view: BlueprintView;
  onSelect(key: string): void;
  onDismiss(): void;
}) {
  const entries = [
    ...diff.added.map((key) => ({ key, verb: 'added' })),
    ...diff.changed.map((key) => ({ key, verb: 'changed' })),
  ].slice(0, 6);
  const more = diff.added.length + diff.changed.length - entries.length;
  return (
    <div className="crf-diff" role="status" data-testid="crf-diff">
      <span className="crf-diff__lead">Blueprint updated</span>
      <span className="crf-diff__sum" data-testid="crf-diff-summary">{summarizeDiff(diff)}</span>
      <span className="crf-diff__items">
        {entries.map(({ key, verb }) => (
          <button type="button" key={key} className="crf-diff__item" data-verb={verb} onClick={() => onSelect(key)}>
            {titleOf(view, key)}
          </button>
        ))}
        {more > 0 ? <span className="crf-diff__more">{`+${more} more`}</span> : null}
        {diff.removed.slice(0, 3).map((node) => (
          <span key={node.key} className="crf-diff__item crf-diff__item--gone" title="Removed">{node.title}</span>
        ))}
      </span>
      <button type="button" className="crf-diff__close" aria-label="Dismiss the change summary" onClick={onDismiss}>
        ×
      </button>
    </div>
  );
}

/** "Task" → "Tasks", from the vocabulary's own plural; unknown labels get an "s". */
function orchestrationNodeKindPlural(label: string): string {
  return ORCHESTRATION_NODE_KINDS.find((kind) => kind.label === label)?.plural ?? `${label}s`;
}
