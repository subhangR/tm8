import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import type { ChatMode, EntityId, SpaceId } from '@tm8/contract';
import { CHATS_ROOT, KindIcon, type HomeRoot } from '../domain';
import { Avatar, Markdown, RibbonMark, Timestamp } from '../kit';
import { chatMarkdownSource } from '../channel-screen/feed-model';
import { ListRootHeader, type ListRootOption } from '../panels/ListRootHeader';
import { ChooseFilesControl } from '../files/ChooseFilesControl';
import { MessageAttachments } from '../files/MessageAttachments';
import type { FileUploadTask } from '../files/upload';
import { DisabledIconControl } from '../panels/honesty/DisabledWithReason';
import {
  AttachmentChips,
  ComposerCard,
  TriggerPopover,
  skillReference,
  useRichInput,
  type TriggerOption,
} from '../rich-input';
import type { ConnectionsReader } from '../session-graph/load';
import type { CockpitStage } from '../routes/types';
import { mergeChatTurnFrame, projectTurnParts, reconcileDetails } from './turn-model';
import { CockpitGraphStage } from './fleet/CockpitGraphStage';
import { FleetPane } from './fleet/FleetPane';
import type { FleetEntityReader } from './fleet/use-fleet-entities';
import type { FleetRowInput } from './fleet/fleet-rows';
import type { ChatEntityResolver } from './EntityChip';
import { ComposerSelect } from './ComposerSelect';
import { EntityTray } from './EntityTray';
import { LedgerPanel } from './LedgerPanel';
import { foldChatLedger, type ChatLedger } from './ledger';
import { TurnParts } from './TurnParts';
import { composeThreadColumn } from './thread-column';
import type {
  ChatHomePort,
  ChatModelOption,
  ChatTeammateOption,
  ChatThreadDetail,
  ChatThreadSummary,
  ChatTurnFrame,
} from './types';
/* THE REFUSAL VOCABULARY'S STYLESHEET, IMPORTED WHERE ITS COMPONENTS ARE USED.
   This screen renders `DisabledIconControl` (the refused attach) but reached it
   by DEEP PATH — `../panels/honesty/DisabledWithReason` — which pulls the
   component and not `panels/index.ts`, the only module that imports
   `honesty.css`. So the markup arrived without its vocabulary.

   It matters most on the phone, and that is what makes it a defect rather than
   an untidiness: `honesty.css` is where the TAP-ONLY disclosure lives
   (`.mobile-frame .hon-disabled[data-reason-open='true'] > .hon-tip`, plus the
   rules that suppress `:hover` there because it STICKS after a tap on iOS).
   Without the file, `useReasonDisclosure`'s tap toggle sets a `data-` attribute
   nothing styles, and `.hon-tip` has no `visibility: hidden` to be revealed
   FROM — so the reason is either permanently on screen or permanently
   unreachable, and which one is not a question the component can answer.

   Following the idiom `files/index.ts`, `auth/index.ts` and
   `settings-space/index.ts` already state in their own words: import another
   lane's stylesheet, never edit it. CSS imports are idempotent, so this is safe
   wherever the file is already present. */
import '../panels/honesty/honesty.css';
import './chat-home.css';

export interface ChatHomeScreenProps {
  port: ChatHomePort;
  spaceId: SpaceId | string;
  /** Bare Home defaults to the space entity. A contextual host passes its entity instead. */
  anchorId?: EntityId;
  /**
   * A host that IS a mode (Craft P1: the Craft studio pins 'craft') — new
   * threads start in it and the mode select is held, exactly as a configured
   * thread's pin holds it. Absent ⇒ the composer's own choice, default 'ask'.
   */
  pinnedMode?: ChatMode;
  models: readonly ChatModelOption[];
  newMutationId?: (prefix: string) => string;
  /** Opens the entity detail panel for an entity a tool call referenced. */
  onOpenEntity?: ((id: EntityId) => void) | undefined;
  /** Lazily resolves title/kind for bare entity ids in tool payloads. */
  resolveEntity?: ChatEntityResolver | undefined;
  /**
   * The host's `entities.connections` reader, for the entity graph's induced
   * relations (never `graph.query` — see `session-graph/model.ts`). Absent ⇒
   * the graph draws every card labelled "edges not read" (R11), never a
   * fabricated line.
   */
  connections?: ConnectionsReader | undefined;
  /** Same authenticated file-byte seam used by the Files screen. */
  assetHref?: ((fileEntityId: EntityId) => string | null) | undefined;
  /**
   * Starts one upload against the anchor this chat writes to.
   *
   * TAKES THE ANCHOR RATHER THAN BEING BOUND TO IT — same signature as
   * `AttachmentsPort.startUpload`, so a host assigns that verb with no
   * adapter. The screen resolves its own anchor (bare Home falls back to the
   * seeded default channel), and binding the port outside would mean the
   * default lived in two places, free to disagree.
   *
   * UPLOADS START IMMEDIATELY, against the ANCHOR, not against the thread: a
   * new conversation has no root message until Send, and holding a pasted
   * file until then would mean the writer watches nothing happen. The anchor
   * exists before the first word is typed.
   *
   * Absent ⇒ paste and drop stay inert and the attach control says why.
   */
  attach?: (file: File, anchorId: EntityId) => FileUploadTask;
  /**
   * Skills `/` can REFERENCE (R1 — the agent reads the link and decides;
   * nothing is invoked). `undefined` ⇒ `/` types plain text.
   */
  skillOptions?: readonly TriggerOption[];
  /**
   * The active ROOT — which population the left column lists — when the HOST
   * owns it (D15: persisted per space; D11 flips it to the session kind from
   * outside this screen on spawn). `CHATS_ROOT` or a collection kind name
   * (task 01a00932 R3: the three-tab column generalized to every kind).
   * Absent ⇒ uncontrolled, defaulting to Chats — the standalone mounts.
   */
  root?: HomeRoot;
  onRoot?: ((root: HomeRoot) => void) | undefined;
  /**
   * What the KIND CELL of the root header names — the current kind root, or
   * (while Chats is the root) the kind the viewer would return to. The host
   * owns the memory; this screen only renders the cell.
   */
  kindCell?: ListRootOption;
  /**
   * The switcher's kind list, the icon rail FLATTENED (R4: rail ≡ switcher
   * by construction — both come from `homeRootKinds()`). Picking one
   * SWITCHES the root; it never creates (R5).
   */
  rootKindOptions?: readonly ListRootOption[];
  /**
   * The entity currently occupying region B, for the HONEST active-row
   * highlight (D9): a task/session row draws active only when it IS the
   * selection; while an entity is selected, no chat row is active.
   */
  selectedEntityId?: string | null;
  /** SELECTING (D7): puts a task/session row's entity in region B. Absent ⇒
   *  those rows render disabled-with-reason, never dead. */
  onSelectEntity?: ((id: string) => void) | undefined;
  /** The host clears region B back to the chat — a chat row click or ＋ New
   *  chat calls it, so the conversation pane (D8: mounted, hidden) returns. */
  onShowChat?: (() => void) | undefined;
  /** R5: the kind cell's `＋` — the host's `useNewTask` create-immediately
   *  flow for the CELL's kind (D2/D3 generalized). Absent ⇒ disabled with
   *  `newEntityUnavailable`'s reason, never hidden. */
  onNewEntity?: (() => void) | undefined;
  newEntityUnavailable?: { cause: string; remedy: string } | null;
  /** The kind menu's PER-ROW ＋ — the cell's verb, for any kind in the list.
   *  See `ListRootHeader.onCreateKind` for why an absent one hides the row
   *  controls rather than refusing fourteen times. */
  onCreateKind?: ((kind: string) => void) | undefined;
  createKindUnavailable?: ((kind: string) => { cause: string; remedy: string } | null) | undefined;
  /**
   * The host's own CONTENT for a KIND root — the workspace's
   * `EntityListPanel` with its full tree, tiles, lifecycle tabs and in-panel
   * search (user ruling 2026-08-16: exact same components). Non-null
   * replaces this screen's list AND its search box for that root (the panel
   * brings its own). A kind root with no hosted list states so honestly —
   * the tab-era built-in task/session rows are retired with the tabs.
   */
  renderRootList?: ((root: HomeRoot) => ReactNode) | undefined;
  /**
   * The conversation the ADDRESS names (`/home/chat/{id}`, task 01a00932
   * D1). Adopted when it differs from the current selection — back/forward
   * and shared links land on the right thread. `null` means the address is
   * bare; the screen keeps its own selection (the cold-start auto-open stays
   * viewer-local and writes no history).
   */
  routeThreadId?: EntityId | null;
  /**
   * USER thread selection, reported so the address can carry it: a row
   * click, ＋ New chat (null — back to the composer), and the send that
   * creates a root. The auto-open deliberately does NOT report — a default
   * is not a navigation.
   */
  onThreadSelected?: ((id: EntityId | null) => void) | undefined;
  /**
   * SOLO MODE (Craft): this screen renders the CONVERSATION ALONE, and the
   * host draws the thread column itself — Craft puts it in a picker on the
   * chat pane's own header, because a studio that is two panes cannot afford
   * a third for a list.
   *
   * Opt-in for one reason: Home's shape is asserted as "EXACTLY TWO PANES"
   * (`GateChatHome.test.tsx`), and the way to give Craft one column without
   * quietly giving Home one too is a prop no Home mount passes.
   *
   * Solo hands selection to the host outright. `routeThreadId` becomes
   * AUTHORITATIVE rather than advisory — including `null`, which means the
   * new-conversation composer (the host's ＋ New chat) rather than the
   * merely-bare address it means everywhere else. There is no second
   * selector left to disagree with it.
   */
  soloConversation?: boolean;
  /**
   * The loaded thread list, published up for a host that draws its own
   * selector. ONE read stays behind it: a host that re-listed for its picker
   * would have a second list free to disagree with this one about what
   * exists, and they would disagree exactly when it matters — right after a
   * send creates a root.
   */
  onThreadsChange?: ((threads: readonly ChatThreadSummary[]) => void) | undefined;
  /**
   * The RESOLVED selection, every time it changes — including the cold-start
   * auto-open that `onThreadSelected` deliberately withholds.
   *
   * The two callbacks answer different questions and a host in solo mode
   * needs both: "did the viewer navigate" (which the address records) is not
   * "which conversation is on screen right now" (which the pane header must
   * name). Withholding the auto-open from a header would leave the picker
   * captioned with nothing while a conversation is plainly open behind it.
   */
  onSelectionChange?: ((id: EntityId | null) => void) | undefined;
  /**
   * WHICH NON-ENTITY COCKPIT STAGE IS UP — `?stage=`, route-owned (replacing
   * `?graph=full`/`?gf=`). The host maps the address here and `onStageChange`
   * navigates it, so Back leaves the stage and a reload restores it. A host
   * without routing omits the pair and simply has no stage tabs.
   *
   * The PANE is rendered here rather than handed in as `centerOverride`
   * because both stages are folds of the THREAD, and the turns live in this
   * component. The host owns the address; this owns the drawing.
   */
  stage?: CockpitStage | null | undefined;
  onStageChange?: ((next: CockpitStage | null) => void) | undefined;
  /**
   * The host's `entities.get`, for the fleet's rows and the graph's late
   * titles. Absent ⇒ both render ids honestly instead of names.
   */
  readEntity?: FleetEntityReader | undefined;
  /** The seam's liveness verdict — the only thing that may call a session
   *  live. Absent ⇒ neutral, never live. */
  livenessOf?: FleetRowInput['livenessOf'];
  /**
   * Open a worker session's TRANSCRIPT view — the session panel's own surface,
   * which this screen links to and never re-renders (there is exactly one
   * transcript renderer and it is not here). ABSENT IS A REAL STATE: a host
   * with nowhere to send the viewer gets no link rather than a dead one.
   */
  onOpenTranscript?: ((id: EntityId) => void) | undefined;
  /**
   * Region B when it is NOT the chat (D7/D8): the host's entity panel,
   * rendered in the conversation pane's place while the conversation stays
   * MOUNTED but hidden — unmounting it would tear down a streaming thread.
   */
  centerOverride?: ReactNode;
  /**
   * Node slot usage for the column foot — `execution.liveness.capacity`,
   * passed through. `undefined` renders NOTHING (absent ≠ zero: no snapshot
   * means nobody measured, not that the node has no slots).
   */
  slots?: { used: number; total: number } | undefined;
  /** The signed-in display name, for the empty-state greeting. */
  viewerName?: string | undefined;
  /**
   * The signed-in actor id, for byline sidedness — the viewer's identity
   * header sits left, everyone else's right. Same source as `viewerName`,
   * never a separate fetch. Role is NOT a substitute: in a shared thread
   * another human's turn is also `role: 'user'`, so sidedness must compare
   * author identity.
   */
  viewerId?: string | undefined;
}

/*
 * `ListRootOption` WAS RE-EXPORTED HERE AS A PURE ALIAS OF `ListRootOption`.
 *
 * The shape moved to `panels/ListRootHeader` when the Work tab adopted the
 * same header (task 01a0102f), and the alias was kept so existing importers
 * would not have to change. The cost of that kindness was that `views/HomeView`
 * imported a Work-tab type FROM CHAT HOME — a dependency describing nothing
 * real, and one that would have broken HomeView for no reason the day this
 * file moved or shrank. Importers now name the canonical type directly.
 */

/**
 * How close to the end still counts as "at the end" for the transcript's
 * stick-to-bottom. Named once because it is read in two places — the `scroll`
 * handler that records the reader's intent and the docblock that explains it —
 * and because a bare `48` in a scroll comparison is the kind of number that
 * gets tuned by whoever is annoyed that week.
 */
const NEAR_BOTTOM_PX = 48;

type ComposerPhase =
  | 'idle'
  | 'posting-root'
  | 'configuring'
  | 'posting-turn'
  | 'streaming'
  | 'stopped-continuable';

export function ChatHomeScreen({
  port,
  spaceId,
  anchorId = spaceId as EntityId,
  pinnedMode,
  models,
  newMutationId = defaultMutationId,
  onOpenEntity,
  resolveEntity,
  connections,
  assetHref,
  attach,
  skillOptions,
  root: rootProp,
  onRoot,
  kindCell,
  rootKindOptions,
  selectedEntityId = null,
  onSelectEntity,
  onShowChat,
  onNewEntity,
  newEntityUnavailable,
  onCreateKind,
  createKindUnavailable,
  routeThreadId,
  onThreadSelected,
  soloConversation = false,
  onThreadsChange,
  onSelectionChange,
  stage = null,
  onStageChange,
  readEntity,
  livenessOf,
  onOpenTranscript,
  renderRootList,
  centerOverride,
  slots,
  viewerName,
  viewerId,
}: ChatHomeScreenProps) {
  const [threads, setThreads] = useState<readonly ChatThreadSummary[]>([]);
  const [teammates, setTeammates] = useState<readonly ChatTeammateOption[]>([]);
  const [selectedRootId, setSelectedRootId] = useState<EntityId | null>(null);
  /* "NOTHING HAS BEEN CHOSEN YET" IS A THIRD STATE, and it used to collide with
     the second one. `selectedRootId === null` is exactly what New conversation
     MEANS — the adopt effect below expresses it that way, and so does
     MobileShell's `onNewThread` (`setThreadId(null)`) — so a `??` chain could
     not tell a deliberately empty composer from a screen that had not chosen
     anything yet, and every background `refreshThreads()` read the viewer's
     composer as "unset" and filled it with whoever had spoken most recently.
     On a phone the composer IS the screen, and the subscribe handler fires a
     refresh for every frame from a root the list has not seen, so in a busy
     space that was constant.

     This ref carries the bit that was missing: the space the current selection
     was RESOLVED for. Not equal to `spaceId` (`null` to begin with) means
     nothing has been chosen here and the cold-start auto-open may run; equal
     means the selection is an answer — `null` included — and only a caller
     asking by name may move it. Space-keyed rather than a bare boolean so
     entering a different space re-arms the cold start on its own, with no
     reset write that would have to be ordered against the adopt effect.

     NOT `spaceRef` BELOW, though both hold a space id. That one is where the
     screen IS as of the last commit, and gates whether a read may write at
     all; this one is what the selection is an answer TO. They differ for
     exactly one commit — the space switch, where `spaceRef` has already
     advanced and this has not — and that is the commit where the difference
     is the whole point: the new space has been chosen in by nobody, so its
     cold start runs. */
  const selectionSpaceRef = useRef<SpaceId | string | null>(null);
  const [detail, setDetail] = useState<ChatThreadDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  /* PER-THREAD DRAFTS (Cockpit ruling 2026-08-18): one box per conversation,
     not one box for the screen — switching threads no longer carries half a
     message into the wrong conversation, and a send in flight clears only the
     ORIGIN thread's draft (the setter is keyed at closure time). Session-local
     by design: reload survival belongs to the store-keyed pattern the channel
     composer uses and is a later step. */
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const draftKey = selectedRootId ?? 'new-thread';
  const draft = drafts[draftKey] ?? '';
  const setDraft = useCallback(
    (next: string | ((current: string) => string)) => {
      setDrafts((current) => {
        const existing = current[draftKey] ?? '';
        const value = typeof next === 'function' ? next(existing) : next;
        return value === existing ? current : { ...current, [draftKey]: value };
      });
    },
    [draftKey],
  );
  const [phase, setPhase] = useState<ComposerPhase>('idle');
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [teammateId, setTeammateId] = useState<EntityId | ''>('');
  const [modelId, setModelId] = useState(models[0]?.model ?? '');
  const [chatMode, setChatMode] = useState<ChatMode>(pinnedMode ?? 'ask');
  const activeRootRef = useRef<EntityId | null>(null);
  const stoppedRootRef = useRef<EntityId | null>(null);
  const detailRef = useRef<ChatThreadDetail | null>(null);
  /** Rolling cache of the active thread's recent frames, replayed over every
   *  snapshot read so a frame published after the read began is never lost
   *  (parts are durable server-side before frames publish, so the snapshot is
   *  authoritative for everything older; the merge is idempotent via per-message
   *  seq dedupe). A message's frames are pruned once its `done` is merged —
   *  they are in the durable snapshot by then — so the cap is a backstop, not
   *  a content-loss cliff. Reset on thread switch. */
  const recentFramesRef = useRef<ChatTurnFrame[]>([]);
  /** Message ids of the active thread's turns that are streaming right now
   *  (delta seen, done not yet). The single source of truth for `streaming`. */
  const liveTurnsRef = useRef<Set<string>>(new Set());
  /** Monotonic frame counter + first-seen index per message, so a done can be
   *  attributed to a turn that STARTED before or after our own post — another
   *  participant's finishing turn must not settle our still-queued one. */
  const frameSeqRef = useRef(0);
  const firstSeenRef = useRef<Map<string, number>>(new Map());
  /** Thread we just posted into and expect to start streaming, plus the frame
   *  counter at post time. Cleared only by a done for a turn that started
   *  after the post (ours or a successor), or by leaving the thread. */
  const expectingRootRef = useRef<EntityId | null>(null);
  const expectingMarkRef = useRef(0);
  /** The turns already on screen when we posted, or null when we have not
   *  posted into this thread. Nothing in that snapshot can be the turn our
   *  pulse stands in for — the server writes the placeholder when it CLAIMS
   *  the turn, strictly after our post — and with no snapshot at all there is
   *  nothing to identify a placeholder by. */
  const preTurnIdsRef = useRef<Set<string> | null>(null);
  /** Per-root single-flight for participant-message refreshes — one thread's
   *  pending refresh must not swallow another thread's. */
  const refreshingRootsRef = useRef<Set<string>>(new Set());
  /** Roots currently known to the sidebar — a frame for an unknown root means
   *  another member started a thread and the list must re-read. */
  const knownRootsRef = useRef<Set<string>>(new Set());
  const refreshingThreadsRef = useRef(false);
  /** The space this screen is mounted for as of the last COMMIT. Every
   *  space-scoped read is checked against it before it writes — a read is
   *  issued for one project and can land after the viewer moved to another. */
  const spaceRef = useRef(spaceId);

  /**
   * ── SWITCHING PROJECT LEAVES NOTHING OF THE OLD ONE BEHIND ────────────────
   *
   * Reported by Subhang: "when project is switched chat list doesn't get
   * updated". Entity ids are SPACE-SCOPED, and `leaveSpaceContext`
   * (`views/GateApp.tsx`) states the invariant in full for the stores it
   * owns — "no state from the old Space survives". It cannot reach this
   * screen's refs, so the screen keeps the same invariant for itself here.
   *
   * `knownRootsRef` is the one that bit. It answers "is this root new?" for
   * the frame handler below, and carrying the previous project's roots across
   * the switch makes it answer for a project the viewer has LEFT — which is
   * precisely the mis-answer that fires the list re-read whose result then
   * lands on top of the new project's list.
   *
   * `useLayoutEffect`, NOT `useEffect`, and not as a preference: passive
   * effects are scheduled, and a frame arriving in that gap would consult refs
   * still describing a space this screen is no longer showing. A layout effect
   * runs in the same synchronous commit as the render that changed `spaceId`,
   * so there is no such gap.
   *
   * It runs BEFORE the adopt effect below (layout before passive), so a host
   * that addresses a conversation in the space being entered still wins — this
   * clears, adoption then re-applies, in that order, in the one commit.
   *
   * A SWITCH, NOT A MOUNT. The early return is not a micro-optimisation: on
   * first mount this state is already empty, and setting it again would be a
   * second render before the opening read has even been issued.
   */
  useLayoutEffect(() => {
    if (spaceRef.current === spaceId) return;
    spaceRef.current = spaceId;
    knownRootsRef.current = new Set();
    setThreads([]);
    setSelectedRootId(null);
    setDetail(null);
  }, [spaceId]);

  useEffect(() => {
    detailRef.current = detail;
  }, [detail]);

  /** ANSWER the question "which conversation?" — `null` is a real answer here
   *  (the new-conversation composer), not the absence of one. Every deliberate
   *  selection goes through this rather than `setSelectedRootId`, so that the
   *  selection and the record of having made one can never drift apart. */
  const chooseRoot = useCallback(
    (next: EntityId | null) => {
      selectionSpaceRef.current = spaceId;
      setSelectedRootId(next);
    },
    [spaceId],
  );

  /**
   * ADOPT the addressed conversation (D1): back/forward and shared links win
   * over the current selection; a bare address changes nothing. The select
   * effect below owns loading whatever this lands on.
   *
   * ── ADOPTING A NAMED THREAD IS A RENDER-PHASE ADJUSTMENT, NOT AN EFFECT ───
   *
   * The adoption used to live in the effect below, and an effect runs AFTER a
   * commit. So one tap in the phone's drawer painted twice: a first frame with
   * the incoming `routeThreadId` but the OUTGOING `selectedRootId` — the old
   * thread's turns, on screen, while the drawer's ✓ had already moved to the
   * new row — and then a second frame once the effect landed. Two full builds
   * of the screen tree, and on a phone, where this screen IS the page, the
   * first of them is a frame of the wrong conversation.
   *
   * This is React's documented "adjusting state when a prop changes": a
   * setState during render of the component's OWN state makes React throw the
   * in-progress output away and re-render immediately, WITHOUT committing. The
   * intermediate frame is never painted, the DOM is written once, and the
   * commit that lands already agrees with the drawer.
   *
   * `adopted` is an object rather than the bare id so that "nothing adopted
   * yet" is distinguishable from "adopted `null`" and from "adopted
   * `undefined`" — the prop is optional, and `undefined` (no host driving the
   * selection) is a THIRD state, not a spelling of `null`.
   *
   * THE FEEDBACK LOOP STILL CLOSES. The screen still publishes every selection
   * the host did not make — see the publish effect below, which has one
   * consequence of this change written on it: landing the adoption a flush
   * earlier is what turned the loop's echo from free into a second shell
   * render, and what the guard there now suppresses.
   *
   * ONLY THE ADOPT HALF MOVED. The solo RESET below is still an effect,
   * deliberately: it clears `detail`, `phase` and `submitError` and writes a
   * ref, and a render pass is not allowed to do any of that. It also does not
   * need to be early — it lands on the new-conversation composer, which is not
   * a thread whose turns could be shown under the wrong selection.
   *
   * AN ADDRESSED THREAD IS A CHOICE, so the adoption goes through `chooseRoot`
   * — it is what stops the cold-start auto-open below from opening the most
   * recent conversation over the top of a thread the host explicitly named.
   * The ref it writes is not rolled back when React throws this render away,
   * and does not need to be: `adopted` is discarded with the render too, so the
   * pair re-runs on the next one and settles on the same answer either way.
   */
  const [adopted, setAdopted] = useState<{ readonly value: EntityId | null | undefined } | null>(
    null,
  );
  if (adopted === null || adopted.value !== routeThreadId) {
    setAdopted({ value: routeThreadId });
    if (routeThreadId && routeThreadId !== selectedRootId) chooseRoot(routeThreadId);
  }

  /* SOLO (Craft, the phone) READS `null` AS AN INSTRUCTION, not as silence.
     With the thread column hosted outside, the host's picker is the ONLY
     selector — so "the host says no thread" can only mean the new-conversation
     composer. Everywhere else a bare address coexists with this screen's own
     column, and overriding the viewer's row click from it would be wrong. */
  useEffect(() => {
    if (!soloConversation || routeThreadId !== null) return;
    /* A `null` FROM THE HOST IS THE VERB ONLY ONCE THERE IS SOMETHING TO
       CLEAR. Before anything has been chosen it is merely the shell's initial
       state — the host mounts holding `null` — and treating that as a choice
       would settle the selection on the composer and starve the cold-start
       auto-open below, which is the phone's only way in. After a selection
       exists, the same `null` is the viewer pressing New conversation, and it
       is recorded as an answer so no background refresh may take it back. */
    if (selectionSpaceRef.current === spaceId) chooseRoot(null);
    else setSelectedRootId(null);
    setDetail(null);
    stoppedRootRef.current = null;
    setPhase('idle');
    setSubmitError(null);
  }, [chooseRoot, routeThreadId, soloConversation, spaceId]);

  /* Publish the list and the RESOLVED selection to a solo host — see the
     props' docblocks for why these are two callbacks and not one.

     THIS EFFECT IS AS CHEAP AS `threads` IS STABLE, and on the phone that is a
     rendering budget rather than a nicety: the solo host wires
     `onThreadsChange` to its OWN `setThreads`, so a fire here re-renders the
     whole shell. Every `setThreads` updater on this screen must therefore
     return `current` unchanged when nothing a row RENDERS moved — see the
     frame updater in the subscribe effect for the case that made this bite. */
  useEffect(() => {
    onThreadsChange?.(threads);
  }, [threads, onThreadsChange]);

  /**
   * ── THE PUBLISH IS FOR SELECTIONS THE HOST DID NOT MAKE ───────────────────
   *
   * `onSelectionChange` exists because two of this screen's OWN behaviours land
   * on a thread the host never chose — cold start opens the most recent
   * conversation, and a first send adopts the root it just created — and after
   * either of them a write-only `routeThreadId` left the shell believing `null`
   * while a real conversation was on screen. That is the whole of the fact it
   * carries, and it is unchanged here.
   *
   * WHAT IS SUPPRESSED IS THE ECHO. When the resolved selection is the one the
   * host just pushed down, the host already knows: publishing it tells it
   * something it told us. `MobileShell`'s docblock reasons that this costs
   * nothing because `setThreadId(B)` from `B` sets no state — and that is true
   * of the STATE, but not of the render. React's eager bailout needs the host's
   * fiber to be idle, and in the flush immediately after the tap it is not, so
   * the echo scheduled a second render of the shell: `screenFor(...)` re-run and
   * the whole screen tree rebuilt, for an answer nobody was waiting for.
   * Measured on this task at 2 shell render passes per tap, 1 with this guard.
   *
   * `routeSeen` is mirrored in a LAYOUT effect rather than during render so
   * this stays a pure read: layout effects run before passive ones, so by the
   * time this publish runs the mirror already holds the route that was pushed
   * in the very same commit.
   *
   * A HOST THAT DRIVES NOTHING IS UNAFFECTED. `routeThreadId` is `undefined`
   * there, which no `EntityId | null` can equal, so the desktop and every test
   * that passes only `onSelectionChange` publish exactly as before.
   */
  const routeSeenRef = useRef(routeThreadId);
  useLayoutEffect(() => {
    routeSeenRef.current = routeThreadId;
  }, [routeThreadId]);

  useEffect(() => {
    if (selectedRootId === routeSeenRef.current) return;
    onSelectionChange?.(selectedRootId);
  }, [selectedRootId, onSelectionChange]);

  /**
   * Re-read the space's thread list.
   *
   * SPACE-SCOPED IN BOTH DIRECTIONS: the read is issued for the space this
   * closure was built for, and a result that lands after the viewer switched
   * projects is DROPPED rather than written. Without that second half a list
   * read started in the old project finishes into the new one and overwrites
   * it — the switch-doesn't-update report. Callers get a promise that resolves
   * either way; nothing depends on distinguishing "read the list" from "read a
   * list we then discarded".
   *
   * IT DOES NOT MOVE THE SELECTION, and `preferRoot` is the only way a caller
   * asks it to. Everything else here is a background re-read — the subscribe
   * handler runs one for every frame from a root the list has not seen, so
   * another member's turn, or any agent starting a thread anywhere in the
   * space, arrives as one — and a background re-read must leave the viewer
   * exactly where they are, mid-conversation or mid-draft on an empty composer.
   * The auto-open at the bottom is the cold start's, not this function's: it
   * can only fire while nothing has been chosen in this space, which is when a
   * refresh happens to beat the opening read.
   */
  const refreshThreads = useCallback(async (preferRoot?: EntityId) => {
    const next = await port.listThreads(spaceId);
    if (spaceRef.current !== spaceId) return;
    knownRootsRef.current = new Set(next.map((thread) => thread.rootId));
    setThreads(next);
    if (preferRoot !== undefined) {
      chooseRoot(preferRoot);
      return;
    }
    if (selectionSpaceRef.current === spaceId) return;
    chooseRoot(next[0]?.rootId ?? null);
  }, [chooseRoot, port, spaceId]);

  /** Read a thread snapshot and replay every cached frame over it, so frames
   *  published after the read began are never lost. Phase is NOT derived here —
   *  `liveTurnsRef`/`turnsDoneRef` are the phase authority, keyed by message
   *  id rather than frame position. */
  const loadDetail = useCallback(
    async (rootId: EntityId): Promise<ChatThreadDetail> => {
      let next = await port.readThread(rootId);
      for (const frame of recentFramesRef.current) {
        if (frame.threadRootId !== rootId) continue;
        next = mergeChatTurnFrame(next, frame);
      }
      return next;
    },
    [port],
  );

  /** Single-flight re-read of the active thread — used when a frame references
   *  a message we do not have yet (another participant posted). */
  const refreshDetail = useCallback(
    (rootId: EntityId) => {
      if (refreshingRootsRef.current.has(rootId)) return;
      refreshingRootsRef.current.add(rootId);
      void loadDetail(rootId)
        .then((next) => {
          if (activeRootRef.current === rootId) {
            setDetail((current) => reconcileDetails(current, next));
          }
        })
        .catch(() => {
          // The next frame or thread switch retries; a missed refresh only
          // delays another participant's message, it never corrupts state.
        })
        .finally(() => {
          refreshingRootsRef.current.delete(rootId);
        });
    },
    [loadDetail],
  );

  useEffect(() => {
    let alive = true;
    setLoading(true);
    setLoadError(null);
    void Promise.all([port.listThreads(spaceId), port.listTeammates(spaceId)])
      .then(([nextThreads, nextTeammates]) => {
        if (!alive) return;
        /* SEED `knownRootsRef` FROM THE SAME READ that fills the list, so the
           two never disagree about what the sidebar knows. This is the read
           that repopulates the list after a project switch cleared it, and
           leaving the ref empty here would leave the frame handler answering
           "new root" for every root it has in fact just been given. */
        knownRootsRef.current = new Set(nextThreads.map((thread) => thread.rootId));
        setThreads(nextThreads);
        setTeammates(nextTeammates);
        /* COLD START (ruled 2026-08-15): the most recent conversation opens
           itself, so the right pane is never empty on launch. `listThreads`
           returns most-recent-first; no conversations at all lands on the new
           conversation composer, which is still a conversation.

           The ruling's follow-on — auto-open silently marks the most recent
           read — DOES NOT BITE YET, and the reason is worth writing down:
           there is no per-conversation unread anywhere to mark.
           `ChatThreadSummary` carries none, the only per-viewer unseen the
           server exposes is KIND-level (`spaces.counts`), and `read_marks` is
           not written per thread. When per-thread unread lands, the accepted
           default is that this auto-open marks read like any other open — see
           the panel's block comment.

           COLD, meaning nothing has been chosen in this space — the guard is
           what makes the word true. This effect re-runs on more than a first
           mount (a space change, a new port), and unconditionally opening the
           most recent conversation on each of those threw away whatever the
           viewer had picked, the new-conversation composer and its typed draft
           included. A space the viewer HAS chosen in fails the test on its own,
           so entering a different space is still a cold start. */
        if (selectionSpaceRef.current !== spaceId) {
          chooseRoot(nextThreads[0]?.rootId ?? null);
        }
        setTeammateId(nextTeammates[0]?.id ?? '');
      })
      .catch((error: unknown) => {
        if (alive) setLoadError(describeError(error));
      })
      .finally(() => {
        if (alive) setLoading(false);
      });
    return () => {
      alive = false;
    };
  }, [chooseRoot, port, spaceId]);

  useEffect(() => {
    activeRootRef.current = selectedRootId;
    recentFramesRef.current = [];
    liveTurnsRef.current.clear();
    firstSeenRef.current.clear();
    if (expectingRootRef.current && expectingRootRef.current !== selectedRootId) {
      expectingRootRef.current = null;
      preTurnIdsRef.current = null;
    }
    if (!selectedRootId) {
      setDetail(null);
      return;
    }
    let alive = true;
    setLoadError(null);
    void loadDetail(selectedRootId)
      .then((next) => {
        if (!alive) return;
        setDetail((current) => reconcileDetails(current, next));
        stoppedRootRef.current =
          next.summary.state === 'stopped-continuable' ? selectedRootId : null;
        setPhase(
          liveTurnsRef.current.size > 0 || expectingRootRef.current === selectedRootId
            ? 'streaming'
            : phaseForThreadState(next.summary.state),
        );
      })
      .catch((error: unknown) => {
        if (alive) setLoadError(describeError(error));
      });
    return () => {
      alive = false;
    };
  }, [loadDetail, selectedRootId]);

  useEffect(
    () =>
      port.subscribe((frame) => {
        if (frame.threadRootId === activeRootRef.current) {
          if (frame.type === 'chat.turn.done') {
            // The turn's parts are all durable in the snapshot by now — its
            // deltas are pure replay weight. Keep the small done frame so a
            // later replay can still restore the usage merge.
            recentFramesRef.current = [
              ...recentFramesRef.current.filter(
                (cached) => cached.messageId !== frame.messageId || cached.type === 'chat.turn.done',
              ),
              frame,
            ];
            liveTurnsRef.current.delete(frame.messageId);
          } else {
            recentFramesRef.current.push(frame);
            liveTurnsRef.current.add(frame.messageId);
            frameSeqRef.current += 1;
            if (!firstSeenRef.current.has(frame.messageId)) {
              firstSeenRef.current.set(frame.messageId, frameSeqRef.current);
            }
          }
          if (recentFramesRef.current.length > 2000) {
            recentFramesRef.current = recentFramesRef.current.slice(-1000);
          }
        }
        // Any thread's activity keeps the sidebar honest, active or not — and
        // a frame for a root the list has never seen means another member
        // started a thread: re-read the list.
        if (!knownRootsRef.current.has(frame.threadRootId) && !refreshingThreadsRef.current) {
          refreshingThreadsRef.current = true;
          void refreshThreads().finally(() => {
            refreshingThreadsRef.current = false;
          });
        }
        /*
         * ── THE FRAME UPDATER IS A NO-OP UNLESS THE LIST ACTUALLY CHANGED ───
         *
         * This ran `current.map(...)` on EVERY frame, and `map` allocates a new
         * array unconditionally — so `threads` took a new identity at streaming
         * TOKEN RATE whether or not any row's rendered facts moved. That
         * identity fires the publish effect above, and on the phone
         * `onThreadsChange` is the SHELL's `setThreads` (`MobileShell`, the
         * `dashboard` arm): every token re-rendered the shell, which re-runs
         * `screenFor` and rebuilds the header, the frame, the drawer and the
         * chat screen. On desktop that repaints one sidebar column; on the
         * phone the chat screen IS the shell, so it repainted the page. That
         * was the flicker Subhang reported.
         *
         * Returning `current` unchanged is the whole fix: React bails out of
         * the state update, `threads` keeps its identity, and the publish
         * effect never fires. It is referential equality and not `memo()` on
         * purpose — a memo would only move the wasted render one level down,
         * and every consumer of the published list would still be woken.
         *
         * AND A DELTA NO LONGER REWRITES `updatedAt`. That field is the SORT
         * KEY `composeThreadColumn` buckets and orders by, so stamping it per
         * token made rows physically reorder underneath a reader while the
         * answer they were reading streamed. During a turn the list only needs
         * the state flip (streaming ⇄ idle) that draws the live pip; the real
         * timestamp is stamped once on `chat.turn.done` — one reorder when the
         * turn is genuinely over, which is what "most recent first" means —
         * and otherwise left to the next `listThreads` read.
         */
        setThreads((current) => {
          const index = current.findIndex((thread) => thread.rootId === frame.threadRootId);
          if (index === -1) return current;
          const thread = current[index];
          if (!thread) return current;
          const done = frame.type === 'chat.turn.done';
          // A delta only ever asserts "this thread is live". If the row already
          // says so, nothing rendered would differ — keep the identity.
          if (!done) {
            if (thread.state === 'streaming') return current;
            const next = current.slice();
            next[index] = { ...thread, state: 'streaming' };
            return next;
          }
          const next = current.slice();
          next[index] = { ...thread, state: 'idle', updatedAt: new Date().toISOString() };
          return next;
        });
        if (frame.threadRootId !== activeRootRef.current) return;
        // A delta for a message we have never seen means another participant
        // started this turn — pull their message in alongside the stream.
        if (
          frame.type === 'chat.turn.delta' &&
          detailRef.current &&
          !detailRef.current.turns.some((turn) => turn.messageId === frame.messageId)
        ) {
          refreshDetail(frame.threadRootId);
        }
        const stopped = frame.threadRootId === stoppedRootRef.current;
        setDetail((current) => {
          if (!current) return current;
          const merged = mergeChatTurnFrame(current, frame);
          return stopped
            ? { ...merged, summary: { ...merged.summary, state: 'stopped-continuable' } }
            : merged;
        });
        if (stopped) setPhase('stopped-continuable');
        else if (frame.type === 'chat.turn.done') {
          if (liveTurnsRef.current.size > 0) return;
          // Only a done for a turn that STARTED after our post settles the
          // expectation — another participant's older turn finishing must not
          // hide the pulse for our still-queued one.
          const startedAt = firstSeenRef.current.get(frame.messageId) ?? 0;
          if (expectingRootRef.current === frame.threadRootId && startedAt < expectingMarkRef.current) {
            return;
          }
          expectingRootRef.current = null;
          preTurnIdsRef.current = null;
          setPhase('idle');
        } else setPhase('streaming');
      }),
    /* `refreshThreads` IS A DEPENDENCY, and omitting it was the switch bug
       rather than a lint nit. It closes over `spaceId`; nothing else in this
       array ever changes when the project does — `port` is memoized on
       [bridge, seam], the bridge on [seam], and the seam is a ref held for the
       app's lifetime. So the subscription was created once and kept calling
       `listThreads` for a project the viewer had left, writing that answer
       straight over the one they had switched TO. Listing it re-subscribes on
       the switch, which is what makes the handler's closure honest about which
       project it is reading; `refreshThreads`' own guard then drops any read
       that was already in flight when the switch happened. Both halves are
       needed — the first stops a stale read being STARTED, the second stops a
       started one LANDING. */
    [port, refreshDetail, refreshThreads],
  );

  /** This thread's own message ids: never chip them — they are already the
   *  transcript. Messages from OTHER sessions/threads keep their chips. Keyed
   *  by the joined ids, not the detail object, so streamed part updates do not
   *  mint a new Set and defeat every tool card's extraction memo. */
  const ownMessageIdsKey = detail
    ? `${detail.summary.rootId}:${detail.turns.map((turn) => turn.messageId).join(',')}`
    : '';
  const ownMessageIds = useMemo(() => {
    if (!detail) return undefined;
    const ids = new Set<string>(detail.turns.map((turn) => turn.messageId));
    ids.add(detail.summary.rootId);
    return ids;
    // eslint-disable-next-line react-hooks/exhaustive-deps -- keyed by id list
  }, [ownMessageIdsKey]);

  /**
   * ── THE TRANSCRIPT OPENS AT THE NEWEST TURN, AND STAYS THERE WHILE IT GROWS ─
   *
   * There was NO scroll logic on this screen at all. `.tch-transcript` is a
   * plain `overflow-y: auto` box, so a conversation opened at `scrollTop: 0` —
   * the reader landed on the oldest message of a thread they came back to for
   * its newest, and a streaming answer wrote itself off the bottom of a box
   * that never followed it. Reported on task 01a01c3f: "it should always scroll
   * to the bottom, when opened, it stays on top."
   *
   * TWO REFS AND NO STATE, deliberately. Scroll position is not something this
   * component renders — nothing on screen changes because the reader scrolled —
   * so putting it in state would re-render the whole transcript on every
   * `scroll` event, which on a long thread is the one place that cost is felt.
   *
   * `stickToBottom` IS THE READER'S INTENT, not a position. Once they scroll up
   * to read back, a still-streaming answer must NOT yank them to the bottom
   * again; the moment they return to within `NEAR_BOTTOM_PX` of the end they
   * have opted back in. That threshold is a tolerance, not a guess: a phone's
   * momentum scroll and the browser's own sub-pixel rounding both land a few
   * pixels short of the exact maximum, and an exact comparison would read a
   * reader who IS at the bottom as one who left.
   *
   * `useLayoutEffect`, so the correction lands in the same frame as the content
   * that caused it. A `useEffect` here paints the un-scrolled frame first and
   * the transcript visibly jumps on every streamed chunk.
   */
  const transcriptRef = useRef<HTMLDivElement | null>(null);
  const stickToBottomRef = useRef(true);
  /**
   * THE HEIGHT THE TRANSCRIPT WAS LAST FOLLOWED TO — the third ref, and the one
   * that keeps this effect from being a scroll SOURCE as well as a scroll sink.
   *
   * `-1` is not "zero pixels", it is NOT FOLLOWING: set while the reader is
   * reading back, and on every thread switch, so the next opt-in re-anchors
   * even when the height it lands on is one this box has been to before.
   */
  const followedHeightRef = useRef(-1);

  const activeConfig = detail?.summary.config ?? null;
  const selectedModel = useMemo(
    () => models.find((model) => model.model === modelId) ?? null,
    [modelId, models],
  );
  const busy = isBusyPhase(phase);
  /** A thread being BORN — the two round trips between Send and a root that
   *  exists. There is no `detail` to hang a pulse off during either, which is
   *  why `thinking` below cannot speak for them. */
  const startingThread = phase === 'posting-root' || phase === 'configuring';
  const thinking = detail !== null && showThinking(phase, detail);
  const pendingTurnId =
    detail !== null && thinking
      ? claimedSilentTurnId(phase, detail, preTurnIdsRef.current)
      : null;
  const newThread = selectedRootId === null;
  const startUnavailable = newThread ? port.startThread.unavailableReason : null;

  /* Opening a conversation is not "growth" — it always lands on the newest
     turn, whatever the reader was doing in the thread they just left. The
     followed height goes with it: the incoming thread is a different box of
     content, so a height it happens to share with the outgoing one must not
     read as "already there". */
  useLayoutEffect(() => {
    stickToBottomRef.current = true;
    followedHeightRef.current = -1;
  }, [selectedRootId]);

  /**
   * ── STICK TO THE BOTTOM, BUT ONLY WHEN THE BOTTOM MOVED ───────────────────
   *
   * Keyed on `detail` and `thinking` because those are exactly the two things
   * that change the transcript's height: every frame merge mints a new detail
   * object (`mergeChatTurnFrame` is immutable), and the waiting mark is a row
   * that appears and disappears under the last turn.
   *
   * A NEW `detail` IS NOT EVIDENCE OF GROWTH, and treating it as such made this
   * effect the phone's jitter source. During a stream a delta lands per token
   * and each one mints a fresh object, but most of them append INSIDE a line
   * that has not wrapped yet: the transcript's `scrollHeight` is unchanged and
   * there is nothing to follow. The old code wrote `scrollTop` anyway, on every
   * one of them. Measured on this task, 10 stream frames at an unchanged height
   * cost 10 scroll writes; with this guard they cost 0.
   *
   * WHY THAT MATTERS HERE AND NOT ON A DESKTOP. `MobileFrame` publishes
   * `--mobile-keyboard-inset` from `useKeyboardInset`, which recomputes on
   * visualViewport `resize` AND `scroll` and resizes the WHOLE frame — so a
   * programmatic scroll is an input to a measurement whose output is a layout
   * change, which is an input to the next scroll. On iOS that closed loop reads
   * as jitter. The hook is not the fault and is not touched: it already rounds
   * and bails on an unchanged value (read its docblock — the `offsetTop` term
   * is load-bearing). The fault is a scroll that nothing asked for.
   *
   * THE READER'S INTENT STILL WINS, and it wins in BOTH directions. While they
   * are reading back, the followed height is dropped rather than remembered —
   * so the moment they come back within `NEAR_BOTTOM_PX` and the next frame
   * lands, they are re-anchored to the end even though the height never moved.
   * Remembering it would have made opting back in silently do nothing.
   */
  useLayoutEffect(() => {
    const element = transcriptRef.current;
    if (!element) return;
    if (!stickToBottomRef.current) {
      followedHeightRef.current = -1;
      return;
    }
    const height = element.scrollHeight;
    if (height === followedHeightRef.current) return;
    followedHeightRef.current = height;
    element.scrollTop = height;
  }, [detail, thinking]);

  const selectionUnavailable =
    teammateId === ''
      ? 'No agent teammate is available in this space.'
      : !selectedModel
        ? 'No model is available from the launch catalog.'
        : null;
  const refusal = startUnavailable ?? selectionUnavailable;

  /**
   * THE THREAD'S THREE WRITE-ONCE FACTS, as the composer's drop-ups read them.
   *
   * A configured thread shows what it was STARTED with and refuses edits; a new
   * thread shows the pending selection and takes them. The two lists carry the
   * config's own label when the catalog no longer offers it — a teammate can
   * leave the space and a model can be retired from the launch catalog after a
   * thread pinned it, and a trigger reading "—" would hide the very fact the
   * thread is pinned to.
   */
  const pinned = activeConfig !== null;
  const shownTeammateId = activeConfig?.teammateId ?? teammateId;
  const shownModelId = activeConfig?.model ?? modelId;
  const shownMode = activeConfig?.mode ?? chatMode;
  const teammateOptions = useMemo(() => {
    const base = teammates.map((teammate) => ({
      id: teammate.id,
      label: teammate.label,
      actor: { id: teammate.id, avatar: teammate.avatar },
    }));
    return activeConfig && !base.some((option) => option.id === activeConfig.teammateId)
      ? [{
          id: activeConfig.teammateId,
          label: activeConfig.teammateLabel,
          actor: { id: activeConfig.teammateId, avatar: null },
        }, ...base]
      : base;
  }, [teammates, activeConfig]);
  const modelOptions = useMemo(() => {
    const base = models.map((model) => ({
      id: model.model,
      label: model.label,
      hint: model.provider,
    }));
    return activeConfig && !base.some((option) => option.id === activeConfig.model)
      ? [{ id: activeConfig.model, label: activeConfig.modelLabel }, ...base]
      : base;
  }, [models, activeConfig]);

  /**
   * THE COMPOSER IS THE SHARED RICH INPUT (chip placement, R4).
   *
   * `/` references a skill; `@` is deliberately NOT declared here — the chat
   * port carries `attachmentIds` and no `mentionIds`, and a picker that
   * committed a name the wire would drop is the same defect this whole
   * migration exists to end. Declaring it absent leaves `@` as plain text,
   * which is honest and is what it already was.
   */
  const composer = useRef<HTMLTextAreaElement | null>(null);
  const rich = useRichInput({
    value: draft,
    onChange: setDraft,
    areaRef: composer,
    triggers: [{
      sigil: '/',
      options: skillOptions,
      onSelect: (option) => ({ insert: skillReference(option.display, option.id) }),
    }],
    attachments: {
      start: attach ? (file: File) => attach(file, anchorId) : undefined,
      placement: { mode: 'chip' },
    },
    onKeyDown: (event) => {
      // `isComposing` guards an IME candidate window: Enter there commits the
      // candidate, and sending on it would post a half-typed word.
      if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
        event.preventDefault();
        void send();
      }
    },
  });
  const attachments = rich.attachments!;
  /* Read at SEND time through a ref, not closed over: `send` is memoised on
     the facts of the conversation, and the staged list changes with every
     upload frame. Closing over it would either stale the ids or churn the
     callback's identity on every render. */
  const attachmentsRef = useRef(attachments);
  attachmentsRef.current = attachments;

  const sendDisabled = busy || draft.trim() === '' || refusal !== null || attachments.blocked;

  /* THE ROOT (task 01a00932 R3 — the three-tab column generalized to chats +
     every collection kind). CONTROLLED when the host owns it (D15 per-space
     persistence; D11's spawn flip arrives from outside) and uncontrolled on
     standalone mounts, opening on Chats. D6: switching the root is BROWSING —
     it re-lists this column and touches nothing else on the screen. */
  const [innerRoot, setInnerRoot] = useState<HomeRoot>(CHATS_ROOT);
  const root = rootProp ?? innerRoot;
  const setRoot = useCallback(
    (next: HomeRoot) => {
      if (onRoot) onRoot(next);
      else setInnerRoot(next);
    },
    [onRoot],
  );
  const onChatsRoot = root === CHATS_ROOT;

  /* The find box serves the CHATS root only (D4's one-box law survives): a
     kind root's hosted list brings its own in-panel search. It filters WHAT
     IS READ — there is no server-side search behind it, and its labels must
     not claim one. */
  const [findQuery, setFindQuery] = useState('');
  const threadGroups = useMemo(
    () => (onChatsRoot ? composeThreadColumn(threads, findQuery) : []),
    [onChatsRoot, threads, findQuery],
  );
  /** D9 — the honest highlight: chat rows are active only while the chat
   *  OCCUPIES region B; an entity selection extinguishes them rather than
   *  fabricating an active row on a root the selection is not from. */
  /**
   * REGION B'S OCCUPANT, resolved once.
   *
   * An entity and a stage both want this berth. THE ENTITY WINS, and the host
   * enforces it upstream by not naming a stage while one is open — but the
   * precedence is restated here because a component that renders both would
   * stack two panes silently, and the failure would look like a CSS bug.
   */
  /* A STAGE IS VALID ON AN EMPTY THREAD. The address says "show me the fleet",
     and a conversation that has delegated nothing has an empty fleet — which
     both panes already say in words. Refusing to render would leave the URL
     naming a stage while the chat is on screen, which is the one state a
     linkable stage must not produce. Turns are taken exactly as the tray takes
     them, so the two never disagree about what this thread contains. */
  const stageTurns = detail && !newThread ? detail.turns : [];
  const stagePane: ReactNode =
    centerOverride != null
      ? null
      : stage === 'fleet'
        ? (
            <FleetPane
              turns={stageTurns}
              suppressEntityIds={ownMessageIds}
              readEntity={readEntity}
              livenessOf={livenessOf}
              onOpenEntity={onSelectEntity ? (id) => onSelectEntity(id) : onOpenEntity}
              {...(onOpenTranscript ? { onOpenTranscript } : {})}
            />
          )
        : stage === 'graph'
          ? (
              <CockpitGraphStage
                turns={stageTurns}
                suppressEntityIds={ownMessageIds}
                connections={connections}
                readEntity={readEntity}
                onOpenEntity={onSelectEntity ? (id) => onSelectEntity(id) : onOpenEntity}
              />
            )
          : null;
  const centre: ReactNode = centerOverride ?? stagePane;

  /* THE DOCK-DOWN (Cockpit ruling 2026-08-18): the centred composer of a new
     thread travels to its bottom berth when the first send lands, instead of
     teleporting. FLIP — the centred position is remembered while the composer
     IS centred, and on the flip the wrap starts from the inverted delta and
     transitions to rest. Guarded by prefers-reduced-motion: reduced means the
     old instant swap, not a slower slide.

     IT KEYS ON "IS THE COMPOSER CENTRED", NOT ON `newThread` ALONE, and the
     difference is a real bug the stages introduced. A stage occupies the
     berth, which un-centres the composer while `newThread` is still true. The
     old effect only re-ran on `newThread`, so it kept the position measured
     before the stage opened; the next real flip would then animate from a
     stale coordinate — a long spurious slide. Worse, a send made WITH a stage
     up would flip a composer that had never moved.

     So: measure whenever centred, and play only when a CENTRED composer stops
     being centred BECAUSE the thread started. Opening or leaving a stage
     therefore never plays it — the flip belongs to the first send, and
     replaying it on stage exit would animate a journey the composer did not
     make. */
  const composerWrapRef = useRef<HTMLDivElement | null>(null);
  const emptyComposerTopRef = useRef<number | null>(null);
  const composerCentred = newThread && centre == null;
  const wasCentredRef = useRef(composerCentred);
  useLayoutEffect(() => {
    const wrap = composerWrapRef.current;
    if (composerCentred) {
      emptyComposerTopRef.current = wrap?.getBoundingClientRect().top ?? null;
    } else if (wasCentredRef.current && !newThread && wrap && emptyComposerTopRef.current !== null) {
      const reduced = typeof window === 'undefined'
        || typeof window.matchMedia !== 'function'
        || window.matchMedia('(prefers-reduced-motion: reduce)').matches;
      const delta = emptyComposerTopRef.current - wrap.getBoundingClientRect().top;
      if (!reduced && delta !== 0) {
        wrap.style.transform = `translateY(${delta}px)`;
        wrap.style.transition = 'none';
        // Reflow commits the inverted start before the transition plays.
        void wrap.getBoundingClientRect();
        wrap.style.transition = 'transform var(--pn-dur-slow, 250ms) var(--pn-ease-standard, ease)';
        wrap.style.transform = '';
        const settle = () => { wrap.style.transition = ''; };
        wrap.addEventListener('transitionend', settle, { once: true });
      }
      emptyComposerTopRef.current = null;
    }
    wasCentredRef.current = composerCentred;
  }, [newThread, composerCentred]);
  const chatOccupiesCenter = centre === undefined || centre === null;
  /** The host's whole-root takeover: the workspace list panel, with its own
   *  search — so this screen's find box stands down for that root. */
  const hostedList = onChatsRoot ? null : (renderRootList?.(root) ?? null);

  const send = useCallback(async () => {
    const body = draft.trim();
    if (body === '' || busy || refusal || teammateId === '' || !selectedModel) return;
    const staged = attachmentsRef.current;
    // An upload still in flight is not a reason to drop it: Send waits rather
    // than posting a message whose file the writer is watching arrive.
    if (staged.blocked) return;
    const attachmentIds = staged.uploadedIds() as EntityId[];
    const continuingStoppedRoot =
      selectedRootId && phase === 'stopped-continuable' ? selectedRootId : null;
    setSubmitError(null);
    const originRoot = selectedRootId;
    try {
      if (selectedRootId) {
        stoppedRootRef.current = null;
        setPhase('posting-turn');
        expectingRootRef.current = selectedRootId;
        expectingMarkRef.current = frameSeqRef.current;
        preTurnIdsRef.current = new Set(
          (detailRef.current?.turns ?? []).map((turn) => turn.messageId),
        );
        await port.postTurn({
          threadRootId: selectedRootId,
          body,
          clientMutationId: newMutationId('chat-turn'),
          ...(attachmentIds.length ? { attachmentIds } : {}),
        });
        // Clear only the draft we actually sent — if the user switched threads
        // and typed something new while the post was in flight, keep it.
        setDraft((current) => (current.trim() === body ? '' : current));
        // Forget the chips WITHOUT cancelling their uploads: the ids are on
        // the message that was just stored.
        staged.clear();
        const posted = await loadDetail(selectedRootId);
        // The user may have switched threads while the post was in flight —
        // this thread's snapshot must never overwrite another thread's screen.
        if (activeRootRef.current === selectedRootId) {
          setDetail((current) => reconcileDetails(current, posted));
          setPhase(
            liveTurnsRef.current.size > 0 || expectingRootRef.current === selectedRootId
              ? 'streaming'
              : 'idle',
          );
        }
        await refreshThreads(
          activeRootRef.current === selectedRootId ? selectedRootId : undefined,
        );
        return;
      }

      setPhase('posting-root');
      const root = await port.startThread.createRoot({
        spaceId,
        anchorId,
        body,
        clientMutationId: newMutationId('chat-root'),
        ...(attachmentIds.length ? { attachmentIds } : {}),
      });
      setPhase('configuring');
      const configured = await port.startThread.configure({
        rootMessageId: root.threadRootId,
        teammateId,
        model: selectedModel.model,
        mode: chatMode,
        clientMutationId: newMutationId('chat-config'),
      });
      if (
        configured.threadRootId !== root.threadRootId ||
        configured.teammateId !== teammateId ||
        configured.model !== selectedModel.model ||
        configured.mode !== chatMode
      ) {
        throw new Error('The node returned a different thread configuration than the one selected.');
      }
      setDraft((current) => (current.trim() === body ? '' : current));
      staged.clear();
      // The select effect owns loading the new thread — a second concurrent
      // read here would race it for setDetail/setPhase. `expecting` keeps the
      // pulse honest until the first frame arrives.
      expectingRootRef.current = root.threadRootId;
      expectingMarkRef.current = frameSeqRef.current;
      preTurnIdsRef.current = new Set();
      chooseRoot(root.threadRootId);
      onThreadSelected?.(root.threadRootId);
      setPhase('streaming');
      await refreshThreads(root.threadRootId);
    } catch (error) {
      // Never let a failed send in one thread rewrite another's phase or show
      // its error under an unrelated conversation.
      if (activeRootRef.current === originRoot) {
        if (continuingStoppedRoot) {
          stoppedRootRef.current = continuingStoppedRoot;
          setPhase('stopped-continuable');
        } else {
          setPhase('idle');
        }
        setSubmitError(describeError(error));
      }
    }
  }, [
    anchorId,
    busy,
    chatMode,
    chooseRoot,
    draft,
    loadDetail,
    newMutationId,
    port,
    phase,
    refreshThreads,
    refusal,
    selectedModel,
    selectedRootId,
    spaceId,
    teammateId,
  ]);

  const interrupt = useCallback(async () => {
    if (!selectedRootId || !port.interrupt) return;
    const rootId = selectedRootId;
    stoppedRootRef.current = rootId;
    try {
      await port.interrupt(rootId);
      const stoppedDetail = await port.readThread(rootId);
      // Live-turn bookkeeping belongs to whichever thread is active NOW — an
      // interrupt that resolves after switching away must not touch it.
      if (activeRootRef.current === rootId) {
        liveTurnsRef.current.clear();
        expectingRootRef.current = null;
        preTurnIdsRef.current = null;
        setDetail((current) => {
          const merged = reconcileDetails(current, stoppedDetail);
          return { ...merged, summary: { ...merged.summary, state: 'stopped-continuable' } };
        });
        setPhase('stopped-continuable');
      }
      setThreads((current) =>
        current.map((thread) =>
          thread.rootId === rootId
            ? { ...thread, ...stoppedDetail.summary, state: 'stopped-continuable' }
            : thread,
        ),
      );
    } catch (error) {
      if (activeRootRef.current === rootId) {
        stoppedRootRef.current = null;
        setPhase('streaming');
        setSubmitError(describeError(error));
      }
    }
  }, [port, selectedRootId]);

  return (
    <main
      className={`tch-root${soloConversation ? ' tch-root--solo' : ''}`}
      data-testid="chat-home-screen"
      data-solo={soloConversation || undefined}
    >
      {/*
        THE NAVIGATION AXIS (task 01a006f8, generalized by task 01a00932).
        This panel is the full inventory AND the only selector, as one ROOT
        column: the chat threads, or ONE collection kind's list — every kind
        the registry offers (R3), picked through the header's kind cell,
        its menu, or the icon rail beside this column (R4: one selection,
        two views of it).
        Switching the root is BROWSING — it re-lists this column only (D6);
        clicking a row is SELECTING — it puts that entity in region B (D7).
        The two ＋ buttons in the header are the single exception to D6:
        each takes region B AND switches this column to its own root (D10).

        NO COUNTS ON THE ROOT LABELS (D16): the only number obtainable is
        "how many are loaded", which would read as a total — absent ≠ zero.

        UNREAD IS NOT DRAWN, AND ITS ABSENCE IS THE HONEST STATE. The ruling
        puts unread state in this panel and nowhere else; what it could not
        know is that no per-conversation unread exists to put here.
        `ChatThreadSummary` has no unread field, the only per-viewer unseen
        the server exposes is KIND-level (`KindCounts.unseen` from
        `spaces.counts`), and `unreadCount` belongs to `channel` ENTITIES,
        which these threads are not. The `read_marks` table can express it —
        nothing writes or reads it per thread yet.

        So the work is a server change (a per-thread unseen read plus a
        mark-read write on open), not a relocation of state that already
        exists, and it is deliberately NOT done here: a dot rendered against
        no measurement would be the fabricated zero this codebase refuses
        everywhere else — the same reason the tab bar's bell carries no count.
        When it lands, the accepted default is that the cold-start auto-open
        marks read like any other open.
      */}
      {/* SOLO: the column is the host's (Craft's pane-header picker). It is
          not rendered hidden — a hidden `role="tab"` list and a second
          searchbox would still be in the a11y tree, offering a keyboard user
          a selector the screen no longer honours. Not mounting it also keeps
          the `id` below unique, which is the property the comment there
          depends on.

          `id` is what Home's column-A separator points `aria-controls` at
          (task 01a00ac2). Only ever one of these mounts at a time — the
          solo-hero arrangement hides this column rather than mounting a
          second grid — so the id stays unique. */}
      {soloConversation ? null : (
      <aside id="home-view-list" className="tch-sidebar" aria-label="Tasks, chats and sessions">
        {/* THE ROOT HEADER (task 01a00932 R5) — two cells, [Chats ＋] and
            [Kind ＋ ▾]. Each cell's LABEL switches the root (browsing, D6);
            each cell's ＋ CREATES (the D10 exception: it takes region B and
            lands the column on its own root). The caret only ever SWITCHES —
            picking a kind from the menu never creates (R5). Labels only, no
            counts (D16).

            THE PANEL'S OWN HEADER ROW IS RETIRED BY THIS LINE: that row
            restated this one's kind and spent 34.9px doing it.

            THE BAR ITSELF NOW LIVES IN `panels/ListRootHeader` (task 01a0102f):
            the Work tab's two columns draw this same header, so it stopped
            being Home's and became a panel-level control. Home keeps the
            `chats` cell; Work omits it, because Chats hosts no list — it swaps
            the surface's CENTRE to the composer, and Work's centre is the ink
            stage. Everything else about the bar is shared, which is the point:
            the two surfaces differ by LAYOUT, not by header. */}
        <ListRootHeader
          rootsLabel="Home roots"
          chats={{
            active: onChatsRoot,
            onSelect: () => setRoot(CHATS_ROOT),
            onCreate: () => {
              chooseRoot(null);
              setDetail(null);
              stoppedRootRef.current = null;
              setPhase('idle');
              setSubmitError(null);
              /* D10: takes region B (back to the chat's new-conversation
                 composer) AND switches the column to its own root. */
              onShowChat?.();
              setRoot(CHATS_ROOT);
              onThreadSelected?.(null);
            },
          }}
          cell={kindCell}
          cellActive={!onChatsRoot}
          onSelectCell={setRoot}
          onCreate={onNewEntity}
          createUnavailable={newEntityUnavailable}
          options={rootKindOptions}
          currentKind={root}
          onPickKind={setRoot}
          onCreateKind={onCreateKind}
          createKindUnavailable={createKindUnavailable}
        />
        {onChatsRoot ? (
          <input
            type="search"
            className="tch-find"
            placeholder="Find a conversation…"
            aria-label="Find a conversation — filters what is already loaded"
            title="Filters the conversations already loaded here; this is not a server search"
            value={findQuery}
            onChange={(event) => setFindQuery(event.target.value)}
          />
        ) : null}
        {hostedList != null ? (
          /* The workspace's own EntityListPanel, given the root's space —
             tree, tiles, lifecycle tiers, sort and search are all its own. */
          <div className="tch-panel-host" data-testid="tch-hosted-list">
            {hostedList}
          </div>
        ) : !onChatsRoot ? (
          /* A kind root with no hosted list: the tab-era built-in rows are
             retired, so the honest state is a refusal, never a blank. */
          <p className="tch-hollow">This list isn’t wired on this surface.</p>
        ) : (
        <div className="tch-thread-list">
          {loading ? (
            <p className="tch-hollow">Reading conversations…</p>
          ) : null}
          {!loading && threadGroups.length === 0 ? (
            <p className="tch-hollow">
              {findQuery.trim()
                ? 'Nothing loaded here matches.'
                : 'No conversations yet. Start with the composer.'}
            </p>
          ) : null}
          {port.threadListUnavailableReason ? (
            <p className="tch-thread-refusal">{port.threadListUnavailableReason}</p>
          ) : null}

          {onChatsRoot
            ? threadGroups.map((group) => (
                <div key={group.label} className="tch-group" role="group" aria-label={group.label}>
                  <span className="tch-group__label">{group.label}</span>
                  {group.rows.map((thread) => (
                    <button
                      type="button"
                      key={thread.rootId}
                      className="tch-thread"
                      /* D9: honest only while the chat occupies B. */
                      data-active={
                        (chatOccupiesCenter && thread.rootId === selectedRootId) || undefined
                      }
                      onClick={() => {
                        /* D7: selecting a chat puts the conversation in B. */
                        chooseRoot(thread.rootId);
                        onShowChat?.();
                        onThreadSelected?.(thread.rootId);
                      }}
                    >
                      <span className="tch-thread__title">
                        {thread.state === 'streaming' ? (
                          <span className="tch-thread__live" title="Agent is working" aria-label="Agent is working" />
                        ) : null}
                        {thread.title}
                      </span>
                      {/* NO PREVIEW LINE. `listThreads` has no message body to
                          preview — `real-port` fills `preview` from the very
                          same root title (F4), so the second line was the first
                          line again, in grey, on every real row. A duplicate
                          costs a row of height and reads as a rendering bug.
                          Craft's picker already lists title + meta only; this
                          makes the two conversation lists one shape. */}
                      <span className="tch-thread__meta">
                        <span className="tch-mode-chip">{thread.config.mode}</span>
                        {/* The teammate's NAME rides the row's ui voice; the
                            MODEL is data and wears mono (Kinetic W3). */}
                        <span>{thread.config.teammateLabel}</span>
                        <span aria-hidden>·</span>
                        <span className="tch-thread__model">{thread.config.modelLabel}</span>
                        <Timestamp at={thread.updatedAt} />
                      </span>
                    </button>
                  ))}
                </div>
              ))
            : null}
        </div>
        )}
        <footer className="tch-sidebar__foot">
          {slots ? (
            slots.total >= UNCAPPED_SESSION_TOTAL ? (
              /* An uncapped node reports int4-max as its total (the spawn
                 guard has no word for "unlimited" — execution-handlers.ts,
                 UNLIMITED_SESSION_CAP). A fraction of a sentinel reads as
                 "9/2147483647"; the honest render is the used count alone. */
              <div className="tch-slots" title={`${slots.used} node session slots in use — this node has no session cap`}>
                <span className="tch-slots__label">session slots</span>
                <span className="tch-slots__nums">{slots.used} in use · no cap</span>
              </div>
            ) : (
              <div
                className="tch-slots"
                title={`${slots.used} of ${slots.total} node session slots in use`}
              >
                <span className="tch-slots__label">session slots</span>
                <span className="tch-slots__bar" aria-hidden>
                  <span
                    className="tch-slots__fill"
                    style={{ width: `${slots.total > 0 ? Math.min(100, (slots.used / slots.total) * 100) : 0}%` }}
                  />
                </span>
                <span className="tch-slots__nums">{slots.used}/{slots.total}</span>
              </div>
            )
          ) : null}
        </footer>
      </aside>
      )}

      {/*
        REGION B — the selection (D5/D7), REVISED by the Cockpit ruling
        2026-08-18: the STAGE swaps, the control panel does not. When a task
        or session is selected the host hands `centerOverride`, and the Fleet
        and Graph stages resolve here (`stage`); either renders
        in the TRANSCRIPT's place while the transcript stays MOUNTED but
        hidden (D8's reason survives — unmounting would tear down a streaming
        thread) — and the composer + entity tray keep their bottom berth, so
        the way back (the tray's Chat tab, Esc) is always on screen.
      */}
      <section
        className="tch-conversation"
        aria-label="Conversation"
        /* The new-conversation state centres greeting + composer as one
           invitation (ref mockup 02); an open thread pins the composer to
           the bottom. Layout only — the CSS pair reads this. */
        data-empty={composerCentred || undefined}
        onKeyDown={(event) => {
          if (event.key !== 'Escape' || centre == null || event.defaultPrevented) return;
          event.preventDefault();
          /* Esc leaves WHATEVER holds the stage. A stage is addressed, so
             leaving it is a navigation, not a local reset — otherwise Back
             would still walk into a stage the viewer just dismissed. */
          if (centerOverride == null && stage !== null) onStageChange?.(null);
          else onShowChat?.();
        }}
      >
        {/* NOT IN SOLO MODE. Solo means the HOST drew the thread column as its
            own header — Craft's `CraftChatPicker` prints this exact title one
            row above — so rendering it again spends 57px restating what the
            viewer just read, and the fallback line ("Work with your graph from
            one place") is a caption for a chooser that solo does not have.
            Full Chat Home keeps the header: there the title lives nowhere else
            on screen, since the thread LIST names threads, not the open one.
            The teammate is not lost — the picker's meta line carries it.

            NOT WHILE SOMETHING ELSE HOLDS THE STAGE EITHER (user report
            2026-08-19, task 01a017d3). The header names the CONVERSATION, and
            with an entity panel or a stage in region B the conversation is not
            what is on screen — so `New conversation · Work with your graph from
            one place` sat above a running terminal, captioning a surface it has
            nothing to do with. It is the chat's chrome; it belongs to the chat.
            (The rest of the chat's chrome around region B — the tray and the
            composer — is a separate open ruling on the same task.) */}
        {soloConversation || centre != null ? null : (
          <header className="tch-conversation__head">
            <div className="tch-title">
              <strong>{detail?.summary.title ?? 'New conversation'}</strong>
              <span>{activeConfig ? `with ${activeConfig.teammateLabel}` : 'Work with your graph from one place'}</span>
            </div>
          </header>
        )}

        {centre != null ? (
          <section className="tch-center" aria-label="Selection" data-testid="tch-center-override">
            {centre}
          </section>
        ) : null}
        <div
          ref={transcriptRef}
          className="tch-transcript"
          aria-live="polite"
          data-hidden={centre != null ? 'true' : undefined}
          hidden={centre != null || undefined}
          /* THE READER'S INTENT, recorded on every scroll and read by the
             stick-to-bottom effect above. Scrolling up to read back opts out of
             following a streaming answer; coming back within the tolerance opts
             straight back in, with no control to find and press. */
          onScroll={(event) => {
            const element = event.currentTarget;
            stickToBottomRef.current =
              element.scrollHeight - element.scrollTop - element.clientHeight <= NEAR_BOTTOM_PX;
          }}
        >
          {loadError ? (
            <div className="tch-load-error" role="alert">
              <strong>Chat could not be read.</strong>
              <span>{loadError}</span>
            </div>
          ) : selectedRootId !== null && detail?.summary.rootId !== selectedRootId ? (
            // Never render one thread's transcript under another thread's
            // selection; a matching transcript stays up through a same-thread
            // reload so fast reads cannot flicker. What stands in for the
            // incoming thread while it is read is the thread ITSELF — see
            // `ThreadOpening`.
            <ThreadOpening
              summary={threads.find((thread) => thread.rootId === selectedRootId) ?? null}
            />
          ) : detail ? (
            <>
              {/* THE GRAPH IS NOT HERE ANY MORE (Cockpit ruling 2026-08-18).
                  It was a strip wedged above the first turn, competing with
                  the conversation for vertical space and needing a second,
                  fullscreen way to be big. It is a STAGE now — one drawing in
                  region B, reached from the tray, addressed by `?stage=graph`. */}
              {detail.turns.map((turn) => (
                <Turn
                  key={turn.messageId}
                  turn={turn}
                  mode={detail.summary.config.mode}
                  pending={turn.messageId === pendingTurnId}
                  viewerId={viewerId}
                  onOpenEntity={onOpenEntity}
                  resolveEntity={resolveEntity}
                  suppressEntityIds={ownMessageIds}
                  assetHref={assetHref}
                  /* One fold for the whole thread (cached on the turns array),
                     so a transition's from-side and a create's parent survive
                     turn boundaries — the same model the sticky projection
                     will render. */
                  ledger={foldChatLedger(detail.turns)}
                />
              ))}
              {thinking ? (
                <div className="tch-wait" role="status" data-testid="chat-thinking">
                  <WaitMark />
                  {phase === 'streaming' ? 'Agent is thinking…' : 'Sending your message…'}
                </div>
              ) : null}
            </>
          ) : loading || startingThread ? (
            /*
             * ── THE WELCOME IS A CLAIM, AND FOR TWO WAITS IT WAS A FALSE ONE ──
             *
             * This arm used to fall straight through to the greeting, which
             * says "New conversation" — an assertion about the space, not a
             * shrug. It was drawn in two states where nobody had established
             * it, and on a phone, where this screen IS the app's front door,
             * both are the first thing the reader sees.
             *
             * `loading` — the opening `listThreads`/`listTeammates` read. Cold
             * start auto-opens the most recent conversation, so the honest
             * answer during that read is "I do not know yet"; the greeting
             * announced an empty space and was then replaced by a conversation
             * that existed the whole time. The only thing that ever covered
             * this read was the SIDEBAR's "Reading conversations…" line, and
             * solo hosts (the phone, Craft) do not mount the sidebar at all —
             * so on exactly the surface with the slowest connection there was
             * no loading state whatsoever.
             *
             * `startingThread` — `posting-root` and `configuring`, the two
             * round trips a first message costs. `thinking` cannot cover them:
             * it is gated on `detail !== null` (it has to be — `showThinking`
             * reads the turns), and a thread being born has no detail yet. So
             * the reader pressed Send on the one screen state where pressing
             * Send is the whole point and watched the greeting sit there.
             *
             * Reported together on task 01a01c3f as "some loaders state
             * mangemetn, loader coming up in the correct time".
             */
            <div className="tch-wait tch-wait--solo" role="status" data-testid="chat-home-loading">
              <WaitMark />
              {startingThread ? 'Starting this conversation…' : 'Reading your conversations…'}
            </div>
          ) : (
            <div className="tch-welcome">
              {/* THE BRAND, NOT A BOLT. This slot held a `⌁` glyph in a bordered
                  card — a placeholder that read as a status icon on the one
                  screen that is the product's front door. The Möbius ribbon is
                  tm8's mark (`kit/RibbonMark`, the same drawing the wordmark,
                  the boot loader and the send button use), so the empty canvas
                  now names the app rather than decorating it. Not animated: the
                  turn is reserved for wait states — see `RibbonMark`'s docblock. */}
              <RibbonMark className="tch-welcome__mark" animated={false} />
              <h1>{greetingLine(viewerName)}</h1>
              <p>New conversation — pick a mode and a teammate, or just type. The agent uses graph tools and keeps every turn in the thread.</p>
            </div>
          )}
        </div>

        {/* THE BOTTOM BERTH IS THE CHAT'S, AND ONLY THE CHAT'S (user report
            2026-08-19, task 01a017d3 — amending the 2026-08-18 Cockpit ruling
            that gave this berth to region B as a whole).

            Nothing of the chat is drawn while an entity panel or a stage holds
            region B. Not the header above, not the composer, and — the part
            this supersedes — NOT THE TRAY EITHER. The first pass kept the tray
            as the way back, reasoning that one ~36px row is cheap. The user's
            answer, seeing it: `why still the chat, fleet, graph is showing at
            the bottom`. Cheap is not the test. The panel is what you opened,
            and a row of another surface's tabs pinned under it is that other
            surface still framing it.

            THE WAY BACK SURVIVES WITHOUT A DOCKED ROW: `Escape` (handled on
            this section), the panel's own ✕, and picking anything in column A.
            None of them cost the panel a pixel.

            The consequence for a STAGE (Fleet/Graph) is sharper than for an
            entity panel — a stage has no ✕ of its own, so Escape and column A
            are the whole exit. Flagged to the user with the change rather than
            quietly softened, because a hidden third case is how a ruling gets
            re-litigated a week later. */}
        {centre != null ? null : (
          <div className="tch-composer-wrap" data-phase={phase} ref={composerWrapRef}>
            {detail && !newThread ? (
              <>
                <EntityTray
                  /* The Graph stage tab. Fleet's tab is absorbed by the
                     ledger panel's scope picker (ruling 11); the ?stage=fleet
                     address keeps working for links already in the wild. */
                  {...(onStageChange ? { onStage: onStageChange, activeStage: stage } : {})}
                  /* Always null here by construction: `centre` is
                     `centerOverride ?? stagePane`, so reaching this branch
                     means BOTH are null and no tab can be the active one. */
                  activeEntityId={null}
                  onShowChat={onShowChat}
                  chatBusy={thinking || phase === 'streaming'}
                />
                <LedgerPanel
                  turns={detail.turns}
                  suppressEntityIds={ownMessageIds}
                  resolveEntity={resolveEntity}
                  /* THE SCREEN'S OPENER, DELIBERATELY — never the
                     `onSelectEntity ?? onOpenEntity` expression the fleet
                     stage uses. Rows open in the RIGHT PANEL (ruling 8);
                     the stage-swap would evict the conversation under its
                     own composer (S5's seam tests pin this). */
                  onOpenEntity={onOpenEntity}
                  readEntity={readEntity}
                  livenessOf={livenessOf}
                />
              </>
            ) : null}
            {submitError ? <p className="tch-submit-error" role="alert">{submitError}</p> : null}
            {refusal ? <p className="tch-refusal" id="tch-compose-refusal">{refusal}</p> : null}
            {phase === 'stopped-continuable' ? (
              <p className="tch-continuable" role="status">
                Turn stopped · this thread is continuable. Send another message to resume.
              </p>
            ) : null}
            <ComposerCard
              className="tch-composer"
              above={<AttachmentChips attachments={attachments} testId="tch-attachments" />}
              field={<>
                <textarea
                  ref={composer}
                  value={draft}
                  aria-label="Message the chat agent"
                  aria-describedby={refusal ? 'tch-compose-refusal' : undefined}
                  disabled={busy}
                  placeholder={
                    newThread ? 'Ask anything about this space…' : 'Reply in this thread…'
                  }
                  rows={2}
                  {...rich.areaProps}
                />
                <TriggerPopover
                  popover={rich.popover}
                  label="Available skills"
                  renderOption={(option) => (
                    <>
                      <span className="ri-popover__name">{`/${option.display}`}</span>
                      {option.meta ? <span className="ri-popover__meta">{option.meta}</span> : null}
                    </>
                  )}
                  emptyText="No matching skills"
                  testId="tch-skill-picker"
                />
              </>}
              foot={<>
                {attach ? (
                  <ChooseFilesControl
                    label="Attach a file"
                    title="attach a file — or drop or paste one into the message"
                    className="tch-attach"
                    inputClassName="tch-attach__input"
                    onChoose={attachments.addFiles}
                  >
                    <span aria-hidden>+</span>
                  </ChooseFilesControl>
                ) : (
                  <DisabledIconControl
                    label="Attach a file"
                    glyph="+"
                    reason={{
                      cause: 'Uploading isn’t wired on this surface',
                      remedy: 'this chat was mounted without an attachment port',
                    }}
                  />
                )}
                {skillOptions ? (
                  <button
                    type="button"
                    className="tch-attach"
                    aria-label="Reference a skill"
                    title="reference a skill — the agent reads it and decides; nothing runs by itself"
                    aria-haspopup="listbox"
                    aria-expanded={rich.popover !== null}
                    onClick={() => {
                      // The button and the typed sigil must land in the SAME
                      // state, or the picker has two behaviours and only one of
                      // them filters.
                      if (rich.popover) rich.popover.close();
                      else rich.openTrigger('/');
                    }}
                  >
                    <span aria-hidden>/</span>
                  </button>
                ) : null}
                {/* The thread's configuration lives HERE and nowhere else. NO
                    `auto` teammate on purpose: there is no routing pipeline that
                    could honour it, and an option that promises routing nobody
                    built is exactly the fabrication this surface refuses. */}
                <span className="tch-picks">
                  <ComposerSelect
                    label="Chat mode"
                    testId="tch-mode"
                    options={MODE_OPTIONS}
                    value={shownMode}
                    onChange={(id) => setChatMode(id as ChatMode)}
                    disabled={pinned || pinnedMode !== undefined}
                    emptyNote="No chat mode is available."
                  />
                  <ComposerSelect
                    label="Chat teammate"
                    testId="tch-teammate"
                    options={teammateOptions}
                    value={shownTeammateId}
                    onChange={(id) => setTeammateId(id as EntityId)}
                    disabled={pinned}
                    emptyNote="No agent teammate is available in this space."
                  />
                  <ComposerSelect
                    label="Chat model"
                    testId="tch-model"
                    options={modelOptions}
                    value={shownModelId}
                    onChange={setModelId}
                    disabled={pinned}
                    emptyNote="No model is available from the launch catalog."
                  />
                </span>
                <span className="tch-phase" role="status">{phaseLabel(phase)}</span>
                {phase === 'streaming' ? (
                  /* The agent-running state lives ON the send button: a loader
                     that is also Stop. Enter still queues a send — the server
                     accepts turns while one runs — so only the button changes
                     role mid-turn, not the composer.
                     Unavailable ≠ invisible: with no interrupt operation on
                     this node the loader stays, disabled with its reason, so a
                     running turn never looks unstoppable by design. */
                  port.interrupt ? (
                    <button
                      type="button"
                      className="tch-send tch-send--working"
                      data-testid="tch-send-working"
                      aria-label="Agent is working — stop this turn"
                      title="Agent is working — click to stop this turn"
                      onClick={() => void interrupt()}
                    >
                      <SendMark /> Stop
                    </button>
                  ) : (
                    <button
                      type="button"
                      className="tch-send tch-send--working"
                      data-testid="tch-send-working"
                      aria-disabled="true"
                      aria-label="Agent is working"
                      title="Agent is working — no chat interrupt operation is exposed on this node; the turn ends on its own"
                    >
                      <SendMark /> Working
                    </button>
                  )
                ) : (
                  <button
                    type="button"
                    className="tch-send"
                    aria-disabled={sendDisabled}
                    onClick={() => void send()}
                    title={
                      refusal
                      ?? (attachments.blocked
                        ? 'One or more attachments are not ready — wait for uploads to finish, retry failures, or remove them before sending.'
                        : undefined)
                    }
                  >
                    Send <span aria-hidden>↑</span>
                  </button>
                )}
              </>}
            />
          </div>
        )}
      </section>
    </main>
  );
}

/**
 * The composer's mode drop-up.
 *
 * Every mode carries the same tool surface (`toolPermission` in @tm8/mcp); the
 * mode states how the teammate works, not what it may touch. So these hints
 * describe intent and must never promise safety — the earlier "changes
 * nothing" copy on ask/explain/plan would now be a lie, because those modes
 * can edit the thread checkout and mutate the graph like any other.
 *
 * The hints are the menu rows' second line rather than a sentence beside a chip
 * row: read on the row it describes, each one is legible; parked at the end of
 * the bar, only the selected mode's was, and it set the composer's width.
 */
const MODE_OPTIONS: readonly { id: ChatMode; label: string; hint: string }[] = [
  { id: 'ask', label: 'ask', hint: 'answers your question; acts only when you ask it to' },
  { id: 'explain', label: 'explain', hint: 'walks the reasoning with inline diagrams, graphs and code' },
  { id: 'plan', label: 'plan', hint: 'shapes work into steps and a durable plan to approve' },
  { id: 'build', label: 'build', hint: 'does the work; edits this thread’s checkout for real' },
  { id: 'orchestrate', label: 'orchestrate', hint: 'dispatches and steers worker sessions' },
  { id: 'craft', label: 'craft', hint: 'sketches a blueprint row; materializes only on approval' },
];

/* -- the two waiting marks -------------------------------------------------

   Both are the tm8 figure-8 from `kit/RibbonMark`, and both are DECORATIVE:
   every site that mounts them already carries the words — `role="status"` on
   the transcript rows, `aria-label` on the send button — so the mark adds
   nothing a reader needs and the `aria-hidden` wrapper keeps it from adding
   noise it does not need either. Same reason `BootLoader` wraps it.

   NOT `BootLoader`. That component's own header scopes it to boot and says so;
   it is a centred column with a label under a 120px mark, which is neither of
   these shapes. What is shared is the mark, so the mark is what is reused.

   WHY THESE ARE THE TWO SURFACES THAT GET IT, and the neighbours do not:

     - `.tch-thread__live` in the sidebar stays a pulsing dot. It marks a row
       as live; it is a STATUS, not a wait, and there is one per streaming
       thread — the one place in this file where marks would multiply.
     - `Reading conversations…` in the sidebar stays plain text. The list it
       is waiting on has known geometry, which is skeleton territory, not
       this (`panels/detail/PanelStates.tsx`).

   The two below are the honest cases: a turn that is pending, and a
   transcript being read. Neither has a shape to be true to until it arrives —
   the same argument `BootLoader` makes for boot. */

/** SEGMENT BUDGETS, measured rather than guessed — see `gate-evidence/`. */
const WAIT_SEGMENTS = 60;
const SEND_SEGMENTS = 44;

/** The transcript's wait row: pending turn, or a conversation being read. */
function WaitMark() {
  return (
    <span className="tch-wait__mark" aria-hidden>
      <RibbonMark className="tch-wait__ribbon" segments={WAIT_SEGMENTS} />
    </span>
  );
}

/**
 * The send button's working state. Smaller, and on a brand-filled ground, so
 * it takes its ink from `--pn-ribbon-ink` — set on the button in chat-home.css
 * because a brand mark on a brand button is an invisible one.
 */
function SendMark() {
  return (
    <span className="tch-send__mark" aria-hidden>
      <RibbonMark className="tch-send__ribbon" segments={SEND_SEGMENTS} />
    </span>
  );
}

/**
 * ── THE CONVERSATION YOU JUST OPENED, WHILE ITS TURNS ARE STILL BEING READ ──
 *
 * Reported by Subhang as "loading a chat flickers the entire page". The arm
 * this replaces drew one centred wait row and nothing else, and the reasoning
 * for it was sound as far as it went: one thread's turns must never be shown
 * under another thread's selection, so the outgoing transcript has to go. What
 * it missed is that ON A PHONE THE TRANSCRIPT IS THE PAGE. Desktop hides the
 * cost because the transcript is one column of three and the other two hold
 * still; at 390px the whole surface collapses to a wait mark and refills, and
 * that collapse-and-refill IS the flicker.
 *
 * ── WHY THIS IS NOT THE OUTGOING TRANSCRIPT, HELD AND DIMMED ───────────────
 *
 * That was the first thing considered and it is the wrong trade. Dimming does
 * not change WHOSE words are on the page: the drawer's ✓ has already moved,
 * the header already names the new conversation, and the paragraphs underneath
 * would still be the old one's. A reader who taps a thread and reads the reply
 * that is sitting there has been told something false, and no amount of opacity
 * un-tells it. `inert` and `aria-hidden` would make it unreachable and unheard,
 * which fixes the interaction and leaves the lie.
 *
 * ── SO WHAT STANDS HERE IS THE SHAPE OF THE THREAD BEING OPENED ───────────
 *
 * `listThreads` has already been read — it is what the drawer's rows ARE — so
 * the incoming thread's `replyCount` is in hand before `readThread` is even
 * called. That is enough to lay out the turns that are coming: placeholder
 * rows, sided the way the real ones will be sided, spaced the way the real
 * ones are spaced, starting where the real ones start. The page keeps its
 * shape through the swap instead of collapsing to a centred mark and refilling
 * from the top, which is the collapse-and-refill the reporter saw.
 *
 * The invariant is not weakened, it is made trivial: nothing of the outgoing
 * thread survives this arm, so there is no arrangement of it that could show
 * one thread's transcript under another thread's selection.
 *
 * ── WHY IT DOES NOT NAME THE THREAD, THOUGH IT COULD ──────────────────────
 *
 * The summary carries a title and a preview and both are true here, so the
 * first draft printed them at the head of the skeleton. It was wrong for a
 * reason worth recording: THE TITLE ALREADY LIVES ON THIS SCREEN. The thread
 * column's row carries it, and on the phone the drawer row the reader just
 * tapped carried it. A second copy inside the transcript puts the same string
 * in two places for the duration of every read — which made twenty-one
 * existing assertions on this screen ambiguous overnight, and that ambiguity
 * is the honest signal, not the test-fixture inconvenience: a reader looking
 * at two identical titles cannot tell which one is the conversation. The
 * skeleton's job is the SHAPE. Naming is the header's job and the row's.
 *
 * CAPPED AT SIX ROWS, and the cap is not cosmetic: `replyCount` on a long
 * thread is in the hundreds, and a skeleton taller than the viewport reserves
 * height for content that will be scrolled past anyway while costing a paint.
 * FLOORED AT TWO, so a one-reply thread still gets a shape rather than a bare
 * line — and a thread reached by address before `listThreads` returned has no
 * summary at all, which is what the default stands in for.
 *
 * `data-testid` and `role="status"` are the ones the old row carried, kept
 * deliberately: `ChatHomeScreen.stability.test.tsx` and `wait-marks.test.tsx`
 * both watch this arm appear and disappear, and that is exactly the fact that
 * has not changed. Only what it looks like has.
 */
function ThreadOpening({ summary }: { summary: ChatThreadSummary | null }) {
  const rows = Math.min(Math.max(summary?.replyCount ?? 3, 2), 6);
  return (
    <div className="tch-opening" role="status" data-testid="chat-detail-loading">
      <div className="tch-wait tch-opening__wait">
        <WaitMark />
        Reading this conversation…
      </div>
      {/* ARIA-HIDDEN, because a skeleton is a promise about layout and not
          content. A screen reader is told "Reading this conversation…" by the
          row above and nothing else; announcing six empty boxes would be noise
          standing in for the very thing that has not arrived. */}
      <div className="tch-opening__rows" aria-hidden>
        {Array.from({ length: rows }, (_, index) => (
          <div
            key={index}
            className="tch-opening__row"
            data-role={index % 2 === 0 ? 'user' : 'assistant'}
          >
            <span className="tch-opening__line" />
            <span className="tch-opening__line tch-opening__line--short" />
          </div>
        ))}
      </div>
    </div>
  );
}

function greetingLine(viewerName?: string): string {
  const hour = new Date().getHours();
  const daypart = hour < 5 ? 'Evening' : hour < 12 ? 'Morning' : hour < 18 ? 'Afternoon' : 'Evening';
  return viewerName ? `${daypart}, ${viewerName}.` : `${daypart}.`;
}

/** The server's "no cap" sentinel: an uncapped node saturates its session cap
 *  at int4 max because the spawn guard cannot express "unlimited"
 *  (`UNLIMITED_SESSION_CAP`, server execution-handlers.ts). A total at or
 *  above it is a sentinel, not a measurement — never a denominator. */
const UNCAPPED_SESSION_TOTAL = 2_147_483_647;

/**
 * Day buckets in the VIEWER's local time — Today, Yesterday, then Earlier —
 * the same grouping the merged column drew, applied to the thread list.
 */
function Turn({
  turn,
  mode,
  pending,
  viewerId,
  onOpenEntity,
  resolveEntity,
  suppressEntityIds,
  assetHref,
  ledger,
}: {
  turn: ChatThreadDetail['turns'][number];
  mode: ChatMode;
  /** This turn is the one the pulse is already announcing. */
  pending?: boolean;
  viewerId?: string | undefined;
  onOpenEntity?: ((id: EntityId) => void) | undefined;
  resolveEntity?: ChatEntityResolver | undefined;
  suppressEntityIds?: ReadonlySet<string> | undefined;
  assetHref?: ((fileEntityId: EntityId) => string | null) | undefined;
  /** The whole thread's ledger fold, for cross-turn memory in the lines. */
  ledger?: ChatLedger | undefined;
}) {
  const label = turn.author?.displayName ?? (turn.role === 'assistant' ? 'Agent' : 'You');
  const actorId = turn.author?.id ?? `chat-${turn.role}`;
  const agent = turn.author?.isAgent ?? turn.role === 'assistant';
  /**
   * Sidedness is decided by AUTHOR IDENTITY, not role — in a shared thread
   * another human's turn is also `role: 'user'` and must land right. A null
   * author on a user turn is your own message rendered optimistically before
   * the server echo; treating it as self prevents a visible left→right flip
   * on send. No `viewerId` degrades to the role heuristic — never crash,
   * never guess.
   */
  const isSelf = viewerId
    ? turn.author
      ? turn.author.id === viewerId
      : turn.role === 'user'
    : turn.role === 'user';
  /**
   * AN ANSWER IS ITS RENDERED PARTS. The server writes the assistant message
   * body twice — 'Agent turn in progress.' when the turn is claimed, the
   * finished text when it completes — because feeds, previews and
   * notifications have no parts to read. Here they do, so printing the body
   * alongside them said the same thing twice: the answer duplicated on every
   * re-read, and a redundant placeholder bubble under the thinking pulse.
   *
   * The test is what the transcript actually DRAWS, not how many rows were
   * stored. `projectTurnParts` folds a call and its result into one card and
   * drops `done` entirely, so a turn that terminated without producing output
   * holds one part and renders nothing — suppressing its body on `length` left
   * an empty bubble where the durable 'Agent turn completed.' should be.
   *
   * A turn that draws nothing is not an answer: either an ordinary message
   * posted into this thread by a teammate, whose body is all it has to say, or
   * the claimed-but-silent turn the pulse is already covering.
   *
   * `turnInFlight` is the server's wire marker for that claim (133 projects
   * `chat_turns.agent_message_id` onto `messages.list`): while it is set the
   * body IS the placeholder, on any read — a reload or thread switch mid-turn
   * included, where the heuristics below have no snapshot to lean on.
   */
  const bodyIsContent =
    (turn.role !== 'assistant' || (projectTurnParts(turn.parts).length === 0 && !pending))
    && !turn.turnInFlight;
  return (
    <article className="tch-turn" data-role={turn.role} data-mode={mode} data-self={isSelf ? 'true' : 'false'}>
      <header className="tch-turn__byline">
        <Avatar
          actorId={actorId}
          provenance={agent ? 'agent' : 'human'}
          label={label}
          size={20}
          src={turn.author?.avatar}
        />
        <strong>{label}</strong>
        <span className="tch-mode-chip" title={`This answer ran in ${mode} mode`}>{mode}</span>
        <Timestamp at={turn.createdAt} />
      </header>
      {bodyIsContent && turn.body ? (
        /* A typed message is MARKDOWN, exactly as the channel feed already
           treats every author — `**bold**` must not print its asterisks here
           while rendering bold one surface over. Same preparation the feed
           uses (empty mention list): a lone newline stays a line break, a
           fenced block keeps its bytes. */
        <Markdown
          source={chatMarkdownSource(turn.body, []).source}
          className="tch-user-body"
          testId="chat-user-body"
        />
      ) : null}
      {/*
        THE FILES THE MESSAGE CARRIES, under the body it was sent with. They
        belong to the durable message, not to the streamed parts, so they sit
        outside `TurnParts` and render on a turn that has no parts at all —
        which is exactly the reporter's case: a human turn that is an image and
        one line of text. `assetHref` is already the transcript's bytes
        resolver (`ChatHomeSurface` hands it `seam.files.downloadHref`); no
        second prop, and no URL built here.
      */}
      <MessageAttachments
        attachments={turn.attachments ?? []}
        downloadHref={assetHref}
        onOpenEntity={onOpenEntity}
        className="tch-turn__attachments"
        testId="chat-turn-attachments"
      />
      <TurnParts
        parts={turn.parts}
        onOpenEntity={onOpenEntity}
        resolveEntity={resolveEntity}
        suppressEntityIds={suppressEntityIds}
        assetHref={assetHref}
        ledger={ledger}
        turnMessageId={turn.messageId}
      />
    </article>
  );
}

function phaseLabel(phase: ComposerPhase): string {
  switch (phase) {
    case 'posting-root': return 'Saving the first prompt…';
    case 'configuring': return 'Starting the agent…';
    case 'posting-turn': return 'Saving your message…';
    // Streaming is announced by the send button itself (the working loader),
    // not by a second label fighting the pinned chip for the same row.
    case 'streaming': return '';
    case 'stopped-continuable': return 'Stopped · continuable';
    default: return '';
  }
}

/** The transcript shows a pulse whenever work is pending but nothing visible is
 *  arriving yet — a queued post, or a streaming turn whose assistant message
 *  has produced no parts. Once parts render, the stream itself is the signal. */
function showThinking(phase: ComposerPhase, detail: ChatThreadDetail): boolean {
  if (phase === 'posting-root' || phase === 'configuring' || phase === 'posting-turn') return true;
  if (phase !== 'streaming') return false;
  const last = detail.turns[detail.turns.length - 1];
  return !last || last.role !== 'assistant' || projectTurnParts(last.parts).length === 0;
}

/**
 * WHICH turn the pulse is standing in for — by identity, never by position.
 *
 * A claimed turn's placeholder and an ordinary message a teammate posted into
 * this thread are INDISTINGUISHABLE on the wire: `role` is derived purely from
 * `author.isAgent`, and `MessageView.parts` is omitted entirely when a message
 * has none, so neither carries a mark saying "I am a chat turn". Position
 * cannot stand in for identity either — the composer stays open during
 * `streaming`, so a later user message can sit after the placeholder, and the
 * placeholder is then no longer the last row.
 *
 * Cardinality does not stand in for it either: a thread can already hold a
 * silent teammate message, which is then the only silent assistant on screen.
 * Nor does arrival: "absent from the rows THIS TAB had rendered" is not the
 * server's ordering, so a teammate message that lands between our post and the
 * claim — or one that was durable all along and unseen here, since this screen
 * never subscribes to ordinary message additions — is equally new to us.
 *
 * The wire marker now exists and is asked FIRST: migration 133 lets
 * `messages.list` project `chat_turns.agent_message_id` as
 * `MessageView.turnInFlight`, so a marked, partless assistant row is the
 * claimed turn by the server's own record — on any read, including a reload
 * or thread switch mid-turn where this tab has no snapshot.
 *
 * The body sentinel stays as the FALLBACK for reads that predate the marker
 * (a detail cached before this shipped). `createAgentMessage`
 * (`server/src/chat/orchestrator.ts:369`, pinned by `chat-storage.pg.test.ts`)
 * writes exactly this body when it claims a turn. Matching it is a heuristic
 * and it is deliberately the one whose failure is BOUNDED: the worst it can do
 * is hide an ordinary message whose entire content is that same sentence,
 * rather than arbitrary teammate content. If the server ever changes the
 * string, suppression stops and the redundant bubble comes back — a blemish,
 * not data loss. That is the safe direction to fail in.
 *
 * For the fallback, arrival and cardinality still gate on top: only rows new
 * to us, and only when exactly one qualifies. With NO snapshot — a reload or
 * a thread switch mid-turn — the fallback suppresses nothing and only the
 * marker can.
 *
 * Candidacy asks for zero STORED parts, not zero rendered ones: a turn that
 * stored only `done` draws nothing but is plainly finished, and is not what a
 * pulse stands in for. (The body fallback still asks the projection — there
 * the question is whether anything was drawn.)
 *
 * During the posting phases the pulse is announcing OUR OWN write, not any
 * turn on screen, so it stands in for nothing and suppresses nothing.
 */
function claimedSilentTurnId(
  phase: ComposerPhase,
  detail: ChatThreadDetail,
  preTurnIds: ReadonlySet<string> | null,
): EntityId | null {
  if (phase !== 'streaming') return null;
  const marked = detail.turns.filter(
    (turn) => turn.role === 'assistant' && turn.turnInFlight === true && turn.parts.length === 0,
  );
  if (marked.length === 1) return marked[0]!.messageId;
  if (preTurnIds === null) return null;
  const silent = detail.turns.filter(
    (turn) =>
      turn.role === 'assistant' &&
      turn.parts.length === 0 &&
      turn.body === CLAIMED_TURN_BODY &&
      !preTurnIds.has(turn.messageId),
  );
  return silent.length === 1 ? silent[0]!.messageId : null;
}

/** The body the server writes onto the agent message when it claims a turn —
 *  `orchestrator.ts:369`, asserted by `server/test/db/chat-storage.pg.test.ts`.
 *  Not a UI string: the transcript never authors it, it only recognises it. */
const CLAIMED_TURN_BODY = 'Agent turn in progress.';

function phaseForThreadState(state: ChatThreadSummary['state']): ComposerPhase {
  if (state === 'streaming') return 'streaming';
  if (state === 'stopped-continuable') return 'stopped-continuable';
  return 'idle';
}

/** Only the user's OWN in-flight write blocks the composer. `streaming` is
 *  deliberately not busy: in a multiplayer thread anyone's agent may be
 *  working, and the server queues turns — typing and sending stay available. */
function isBusyPhase(phase: ComposerPhase): boolean {
  return phase === 'posting-root' || phase === 'configuring' || phase === 'posting-turn';
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function defaultMutationId(prefix: string): string {
  return `${prefix}:${crypto.randomUUID()}`;
}
