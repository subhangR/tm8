import { Fragment, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import type { ChatMode, EntityId, LaunchModelEffort, SessionTranscriptContext, SpaceId } from '@tm8/contract';
import { CHATS_ROOT, KindIcon, actorName, type HomeRoot } from '../domain';
import { rememberChatStart } from '../chat-defaults/lastUsed';
import { Avatar, Markdown, RibbonMark, Timestamp } from '../kit';
import { chatMarkdownSource } from '../channel-screen/feed-model';
import { ListRootHeader, type ListRootOption } from '../panels/ListRootHeader';
import { MessageAttachments } from '../files/MessageAttachments';
import type { FileUploadTask } from '../files/upload';
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
import {
  CLAIMED_TURN_BODY,
  appendOptimisticTurn,
  dropTurn,
  maxPartSeq,
  mergeChatTurnFrame,
  optimisticTurnId,
  projectTurnParts,
  reconcileDetails,
  settleOptimisticTurn,
} from './turn-model';
import { clockFromRead, startTurnClock, useTurnInProgress, type TurnClock } from './turn-in-progress';
import { defaultChatTeammateId } from './default-teammate';
import { CockpitGraphStage } from './fleet/CockpitGraphStage';
import { FleetPane } from './fleet/FleetPane';
import type { FleetEntityReader } from './fleet/use-fleet-entities';
import type { FleetRowInput } from './fleet/fleet-rows';
import { EntityChip, type ChatEntityResolver } from './EntityChip';
import { ComposerSelect, type ComposerSelectOption } from './ComposerSelect';
import { ChatContextNumber, staleReason } from './ChatContextNumber';
import {
  AddToTurnMenu,
  CrewPanel,
  MODE_GROUPS,
  MODE_SPECS,
  ModeOptionsSlot,
  ModelEffortPicker,
  ThreadRail,
  coordinatorModelChoices,
  crewBrief,
  modeConflict,
  modeFromSlash,
  modeSpec,
  nearestEffort,
  projectBindingFromChoice,
  rungFromPermissionMode,
  teammateRoster,
  type CrewSpec,
  type ModeOptionsByMode,
  type PermissionRung,
} from './composer';
import { EntityTray } from './EntityTray';
import { LedgerHostProvider } from './LedgerCards';
import { LedgerPanel } from './LedgerPanel';
import { TranscriptDock } from './LiveTurnStatus';
import { useTranscriptFollow } from './live-turn-status-follow';
import { foldChatLedger, type ChatLedger } from './ledger';
import { TurnParts, type TurnPartsProps } from './TurnParts';
import { composeThreadColumn } from './thread-column';
import type {
  ChatHomePort,
  ChatModelOption,
  ChatProjectOption,
  ChatTeammateOption,
  ChatThreadDetail,
  ChatThreadSummary,
  ChatTurnFrame,
  NewChatSeed,
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
  /**
   * The entity a NEW chat here is about (176). Craft passes the blueprint; bare
   * Home passes none.
   *
   * IT IS NOT AN ANCHOR ANY MORE, which is why it is not called one. A chat
   * used to have to be posted onto somebody else's row — the seeded default
   * channel for bare Home (GateApp substituted it because the space id is not
   * an entity and messages.post 404s on it), the blueprint for Craft. A chat
   * anchors its own transcript now, so the context entity is a RELATION the
   * server writes as an `about` edge, and a chat with no subject simply has
   * no edge instead of borrowing a channel's identity.
   */
  aboutId?: EntityId;
  /**
   * A host that IS a mode (Craft P1: the Craft studio pins 'craft') — new
   * threads start in it and the mode select is held, exactly as a configured
   * thread's pin holds it. Absent ⇒ the composer's own choice, default 'ask'.
   */
  pinnedMode?: ChatMode;
  /**
   * COMPOSER SEED — a host putting text into the draft (Craft's "Ask about
   * this" and its example prompts). Applied once per `nonce`: appended to the
   * CURRENT draft with one separating space, never replacing what the viewer
   * already typed, then the caret lands at the end. Absent ⇒ nothing happens;
   * no other host passes it.
   */
  composerSeed?: { text: string; nonce: number } | undefined;
  /**
   * NEW-CHAT SETTINGS SEED — the entity chat's settings card or its
   * skip-when-default rule (design 01a0da4e §3.4) choosing teammate, model,
   * mode and project before the first message. Read ONCE, as the new-thread
   * composer's starting chips; every chip stays editable. A teammate or model
   * this node does not list falls back to the composer's own default. Absent ⇒
   * the composer's own defaults, unchanged.
   */
  newChatSeed?: NewChatSeed | undefined;
  /**
   * What the NEW-CONVERSATION state says above the composer, when the host
   * knows better than the generic greeting (Craft explains what the craft
   * agent will do with the blueprint). Absent ⇒ the greeting, unchanged.
   */
  newThreadIntro?: ReactNode;
  /** A host's note under a tool call (see `TurnPartsProps.toolNote`). */
  toolNote?: TurnPartsProps['toolNote'];
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
   * Starts one upload for a staged chip.
   *
   * THE ANCHOR IS OPTIONAL, AND FOR A NEW CHAT THERE IS NONE (176). Uploads
   * start immediately — a writer who pastes an image must not watch nothing
   * happen until Send — and a new conversation has no entity to hang them off
   * yet. `FileUploadTaskOptions.anchorId` has been optional since the
   * files-explorer lane: an anchor-less upload lands in the space library
   * attached to nothing, and `chat.start` then carries its id in
   * `attachmentIds`, which is what writes the `attached_to` edge to the
   * opening message. That is strictly more honest than the old behaviour,
   * which attached every staged file to the seeded default channel because
   * the chat had no id of its own to offer.
   *
   * Absent ⇒ paste and drop stay inert and the attach control says why.
   */
  attach?: (file: File, anchorId?: EntityId) => FileUploadTask;
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
   * WHAT A COLD START OPENS. `'latest'` (the default, ruled 2026-08-15) opens
   * the space's most recent conversation so the pane is never empty.
   * `'composer'` opens the new-conversation composer instead, and is what the
   * entity chat slot asks for when its thread is `new`: that host has ALREADY
   * decided no existing chat is wanted, and auto-opening the space's latest
   * chat — about some other entity entirely — would contradict the address.
   */
  coldStart?: 'latest' | 'composer';
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
  aboutId,
  pinnedMode,
  composerSeed,
  newChatSeed,
  newThreadIntro,
  toolNote,
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
  coldStart = 'latest',
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
  /** The turn pipeline's clock — when the turn in progress began, when its
   *  last frame merged, which agent message it is. Nothing on the wire carries
   *  these; `useTurnInProgress` folds them with `phase` and `detail` into the
   *  one value the live status row reads. */
  const [turnClock, setTurnClock] = useState<TurnClock | null>(null);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [teammateId, setTeammateId] = useState<EntityId | ''>('');
  const [modelId, setModelId] = useState(() =>
    newChatSeed?.model && models.some((model) => model.model === newChatSeed.model)
      ? newChatSeed.model
      : (models[0]?.model ?? ''));
  const [chatMode, setChatMode] = useState<ChatMode>(pinnedMode ?? newChatSeed?.mode ?? 'ask');
  /* The seed is a STARTING value: the roster read below lands after mount, so
     the seeded teammate is kept in a ref and applied when it does. */
  const newChatSeedRef = useRef(newChatSeed);
  /* THE REST OF THE COMPOSER'S SHAPE. Per-turn: effort (remembered PER MODE),
     the ⚙ options, the ＋ menu's enabled skills. Thread-scope: the project
     binding (write-once on the server) and the permission ceiling. `null`
     permission means "not chosen" — the rail derives the default from the
     teammate's own `permission_mode` and says so. */
  const [effortByMode, setEffortByMode] = useState<Partial<Record<ChatMode, LaunchModelEffort>>>({});
  const [modeOptions, setModeOptions] = useState<ModeOptionsByMode>({});
  const [enabledSkills, setEnabledSkills] = useState<string[]>([]);
  const [projectChoice, setProjectChoice] = useState(newChatSeed?.projectId ?? '');
  const [projects, setProjects] = useState<readonly ChatProjectOption[] | null>(null);
  const [permissionChoice, setPermissionChoice] = useState<PermissionRung | null>(null);
  const [crew, setCrew] = useState<CrewSpec>({ workers: [] });
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
   *  pending refresh must not swallow another thread's. The value records that
   *  another refresh was asked for while one was in flight: that one runs
   *  AFTER, because its caller may know something the running read predates
   *  (a done whose final body the running read cannot contain). */
  const refreshingRootsRef = useRef<Map<string, boolean>>(new Map());
  /** Highest delta seq this tab has SEEN per agent message, beside what the
   *  snapshot holds — a delta further ahead than one step means frames were
   *  lost on the way and the thread is re-read. Reset on thread switch. */
  const seenSeqRef = useRef<Map<string, number>>(new Map());
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
    /* doc 15 B2: the composer's project binding is a `projects.id` linked to
       the space being LEFT. Carried across, the next chat started here would
       name a project this space may not have — refused by `chat_start`
       ("project is not linked to this space"), or, where both spaces link
       the same folder, silently bound to it without the viewer choosing it
       in this space. Back to the default (scratch) on every switch. */
    setProjectChoice('');
  }, [spaceId]);

  useEffect(() => {
    detailRef.current = detail;
  }, [detail]);
  /** The clock as of the last commit — what a failed send restores. */
  const turnClockRef = useRef<TurnClock | null>(null);
  useEffect(() => {
    turnClockRef.current = turnClock;
  }, [turnClock]);

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
    chooseRoot(coldStart === 'composer' ? null : (next[0]?.rootId ?? null));
  }, [chooseRoot, coldStart, port, spaceId]);

  /** Read a thread snapshot and replay every cached frame over it, so frames
   *  published after the read began are never lost. Phase is NOT derived here —
   *  `liveTurnsRef`/`turnsDoneRef` are the phase authority, keyed by message
   *  id rather than frame position. */
  const loadDetail = useCallback(
    async (rootId: EntityId): Promise<ChatThreadDetail> => {
      let next = await port.readThread(rootId);
      for (const frame of recentFramesRef.current) {
        if (frame.chatId !== rootId) continue;
        next = mergeChatTurnFrame(next, frame);
      }
      return next;
    },
    [port],
  );

  /** Single-flight re-read of the active thread — used when a frame references
   *  a message we do not have yet (another participant posted). */
  const refreshDetail = useCallback(
    function refresh(rootId: EntityId) {
      const running = refreshingRootsRef.current;
      if (running.has(rootId)) {
        running.set(rootId, true);
        return;
      }
      running.set(rootId, false);
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
          const again = running.get(rootId) === true;
          running.delete(rootId);
          if (again && activeRootRef.current === rootId) refresh(rootId);
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
          chooseRoot(coldStart === 'composer' ? null : (nextThreads[0]?.rootId ?? null));
        }
        setTeammateId(defaultChatTeammateId(nextTeammates, {
          seeded: newChatSeedRef.current?.teammateId,
          pinnedMode,
        }));
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
  }, [chooseRoot, coldStart, pinnedMode, port, spaceId]);

  useEffect(() => {
    activeRootRef.current = selectedRootId;
    recentFramesRef.current = [];
    liveTurnsRef.current.clear();
    firstSeenRef.current.clear();
    seenSeqRef.current.clear();
    // The clock describes one conversation; a chat just born keeps its own.
    setTurnClock((current) => (current && current.chatId !== selectedRootId ? null : current));
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
        const opened =
          liveTurnsRef.current.size > 0 || expectingRootRef.current === selectedRootId
            ? 'streaming'
            : phaseForThreadState(next.summary.state);
        setPhase(opened);
        /* A TURN ALREADY RUNNING WHEN THE THREAD OPENED — a reload or a switch
           mid-turn. It started before this tab saw it, so its clock starts at
           the claim (the agent message's own createdAt), not at the read. */
        if (opened === 'streaming') {
          setTurnClock((current) =>
            current && current.chatId === selectedRootId
              ? current
              : clockFromRead(selectedRootId, next, Date.now()));
        }
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
        /* Read BEFORE the done prunes this message's deltas from the cache:
           the error part may not have reached `detail` yet if both frames
           landed in one tick. */
        const failure =
          frame.type === 'chat.turn.done' && frame.chatId === activeRootRef.current
            ? turnFailureOf(frame.messageId, recentFramesRef.current, detailRef.current)
            : null;
        if (frame.chatId === activeRootRef.current) {
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
        if (!knownRootsRef.current.has(frame.chatId) && !refreshingThreadsRef.current) {
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
          const index = current.findIndex((thread) => thread.rootId === frame.chatId);
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
        if (frame.chatId !== activeRootRef.current) return;
        if (frame.type === 'chat.turn.delta') {
          const inSnapshot =
            detailRef.current?.turns.some((turn) => turn.messageId === frame.messageId) ?? false;
          const seenBefore = seenSeqRef.current.get(frame.messageId);
          const highest = Math.max(seenBefore ?? -1, maxPartSeq(detailRef.current, frame.messageId));
          seenSeqRef.current.set(frame.messageId, Math.max(highest, frame.seq));
          // A delta for a message we have never seen means another participant
          // started this turn — pull their message in alongside the stream.
          const unknown = !inSnapshot && seenBefore === undefined;
          /* A SEQ GAP IS A LOST FRAME. Parts are durable before their frame
             publishes, so a delta more than one step past everything seen
             means the ones between were dropped on the way (a socket blip, a
             frame that raced the snapshot) — and nothing else would ever
             bring them back before a reload. Re-read; the merge is
             idempotent by seq. */
          const gap = !unknown && frame.seq > highest + 1;
          if (detailRef.current && (unknown || gap)) refreshDetail(frame.chatId);
          const at = Date.now();
          setTurnClock((current) =>
            current && current.chatId === frame.chatId && current.error === null
              ? { ...current, lastFrameAt: at, messageId: frame.messageId }
              : { ...startTurnClock(frame.chatId, at, frame.messageId), lastFrameAt: at },
          );
        } else {
          /* The turn's durable end state — its final body, anything a lost
             frame kept from the stream — is one read away, and nothing else
             would fetch it until the thread is reopened. */
          refreshDetail(frame.chatId);
        }
        const stopped = frame.chatId === stoppedRootRef.current;
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
          if (expectingRootRef.current === frame.chatId && startedAt < expectingMarkRef.current) {
            // An earlier turn finished; ours is still queued behind it.
            setTurnClock((current) =>
              current && current.chatId === frame.chatId
                ? { ...current, messageId: null, lastFrameAt: null }
                : current,
            );
            return;
          }
          expectingRootRef.current = null;
          preTurnIdsRef.current = null;
          setPhase('idle');
          /* A clean done clears the turn; a failed one is HELD (with the time
             it ended, so the row's clock freezes) until the next send. */
          const ended = Date.now();
          setTurnClock((current) =>
            failure === null
              ? null
              : {
                  ...(current && current.chatId === frame.chatId
                    ? current
                    : startTurnClock(frame.chatId, ended, frame.messageId)),
                  messageId: frame.messageId,
                  stopping: false,
                  error: failure,
                  endedAt: ended,
                },
          );
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

  /**
   * ── A SOCKET THAT DROPPED MID-TURN LOST ITS DELTAS ─────────────────────────
   *
   * Chat frames are not durable events: nothing replays the ones published
   * while the socket was down. Before this, a blip mid-turn left the
   * transcript missing every part from the gap, and a turn that FINISHED
   * during it never settled — its done had gone by, so the composer stayed
   * "working" until a reload. On reconnect the list and the open thread are
   * re-read (parts are durable before they publish, so the snapshot has
   * everything) and the phase is re-derived from what the server says now.
   * Our own post in flight keeps its phase — that is ours to settle.
   */
  useEffect(
    () =>
      port.subscribeReconnect?.(() => {
        const rootId = activeRootRef.current;
        void refreshThreads()
          .then(() => (rootId && activeRootRef.current === rootId ? loadDetail(rootId) : null))
          .then((next) => {
            if (!next || !rootId || activeRootRef.current !== rootId) return;
            setDetail((current) => reconcileDetails(current, next));
            if (stoppedRootRef.current === rootId) return;
            if (next.summary.state === 'streaming') {
              setPhase((current) => (isBusyPhase(current) ? current : 'streaming'));
              /* A turn that STARTED during the drop has no clock yet — without
                 one the turn in progress reads null (no shell, no live row)
                 until its next frame, which can be a minute away. */
              setTurnClock((current) =>
                current && current.chatId === rootId ? current : clockFromRead(rootId, next, Date.now()));
              return;
            }
            liveTurnsRef.current.clear();
            if (expectingRootRef.current === rootId) {
              expectingRootRef.current = null;
              preTurnIdsRef.current = null;
            }
            setPhase((current) => (isBusyPhase(current) ? current : phaseForThreadState(next.summary.state)));
            setTurnClock((current) => (current && current.chatId === rootId && current.error === null ? null : current));
          })
          .catch(() => {
            // The next frame, reconnect or thread switch tries again.
          });
      }),
    [loadDetail, port, refreshThreads],
  );

  // Live context readings, per chat: a frame for one chat must never draw on
  // another's header, and a chat switched away from and back keeps the newest
  // reading this screen saw rather than the older one its list row carried.
  const [liveContext, setLiveContext] = useState<ReadonlyMap<EntityId, SessionTranscriptContext>>(
    () => new Map(),
  );
  useEffect(
    () =>
      port.subscribeContext?.((frame) =>
        setLiveContext((prev) => new Map(prev).set(frame.chatId, frame.context))),
    [port],
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
  /** THE TURN IN PROGRESS — the contract lane 2's live status row reads. */
  const turnInProgress = useTurnInProgress({ phase, detail, clock: turnClock });
  /** The agent's turn stands on screen from Send (D12): a shell — byline, empty
   *  body — until the real agent message is in the transcript to take over. */
  const shellTurn = detail && turnInProgress && SHELL_PHASES.has(turnInProgress.phase)
    && !detail.turns.some((turn) => turn.messageId === turnInProgress.messageId)
    ? agentShellTurn(detail, turnInProgress.startedAt)
    : null;
  const liveMessageId = turnInProgress && SHELL_PHASES.has(turnInProgress.phase)
    ? turnInProgress.messageId
    : null;
  const pendingTurnId =
    detail !== null && thinking
      ? claimedSilentTurnId(phase, detail, preTurnIdsRef.current)
      : null;
  const newThread = selectedRootId === null;
  const startUnavailable = newThread ? port.startThread.unavailableReason : null;

  /* LANE 2: the in-flight message's parts, for the live row's words. The
     turn itself is lane 1's `turnInProgress` above; this only looks it up. */
  const liveParts =
    turnInProgress?.messageId && detail
      ? (detail.turns.find((turn) => turn.messageId === turnInProgress.messageId)?.parts ?? null)
      : null;
  /* THE TRANSCRIPT OPENS AT ITS NEWEST TURN, STAYS THERE WHILE IT GROWS, and
     never moves a reader who scrolled up — `live-turn-status-follow.ts`, which
     also offers that reader the way back. `tail` is the live row's phase: the
     row sits under the last turn, so it appearing or changing moves the end. */
  const follow = useTranscriptFollow({
    threadKey: selectedRootId,
    content: detail,
    tail: turnInProgress?.phase ?? null,
    itemCount: detail?.turns.length ?? 0,
  });

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
  /* Under orchestrate the roster is COORDINATORS ONLY (ac_7); the model
     decides, the effect below applies its preselect. */
  const roster = useMemo(
    () => teammateRoster(teammates, shownMode, shownTeammateId),
    [teammates, shownMode, shownTeammateId],
  );
  useEffect(() => {
    if (!pinned && roster.preselect) setTeammateId(roster.preselect);
  }, [pinned, roster.preselect]);
  const teammateOptions = useMemo(() => {
    const base = roster.options.map((teammate) => ({
      id: teammate.id,
      label: teammate.label,
      actor: { id: teammate.id, avatar: teammate.avatar },
      ...(teammate.mode ? { hint: teammate.mode } : {}),
    }));
    return activeConfig && !base.some((option) => option.id === activeConfig.teammateId)
      ? [{
          id: activeConfig.teammateId,
          label: activeConfig.teammateLabel,
          actor: { id: activeConfig.teammateId, avatar: null },
        }, ...base]
      : base;
  }, [roster.options, activeConfig]);
  /* The COORDINATOR's list: codex models drawn disabled with the reason (ac_10). */
  const modelChoices = useMemo(() => {
    const base = coordinatorModelChoices(models);
    return activeConfig && !base.some((option) => option.id === activeConfig.model)
      ? [{ id: activeConfig.model, label: activeConfig.modelLabel }, ...base]
      : base;
  }, [models, activeConfig]);
  /* Effort rides the model popover and is remembered per mode; a model that
     lacks the remembered stop snaps to its nearest one. */
  const effort = useMemo<LaunchModelEffort | null>(() => {
    const wanted = effortByMode[shownMode] ?? modeSpec(shownMode).defaultEffort;
    return nearestEffort(wanted, selectedModel?.efforts ?? []);
  }, [effortByMode, shownMode, selectedModel]);
  const modeSelectOptions = useMemo<ComposerSelectOption[]>(
    () => MODE_SPECS.map((spec) => ({
      id: spec.id,
      label: spec.label,
      hint: spec.consequence,
      group: MODE_GROUPS.find((group) => group.id === spec.group)?.label ?? spec.group,
    })),
    [],
  );
  /* THE CEILING. Default = the teammate's own `permission_mode`, said out loud. */
  const shownTeammate = teammates.find((teammate) => teammate.id === shownTeammateId);
  const derivedPermission = rungFromPermissionMode(shownTeammate?.permissionMode);
  const permission = permissionChoice ?? derivedPermission;
  const permissionSource = permissionChoice === null && shownTeammate
    ? `${shownTeammate.label} defaults to ${derivedPermission === 'read-only' ? 'Read-only' : derivedPermission === 'auto' ? 'Auto' : 'Ask first'}`
    : null;
  const conflict = modeConflict(shownMode, permission);
  const projectBinding = projectBindingFromChoice(projectChoice);
  const lockedProjectLabel = activeConfig
    ? activeConfig.workdirMode === 'project' && activeConfig.projectId
      ? projects?.find((project) => project.id === activeConfig.projectId)?.name ?? 'Project'
      : activeConfig.workdirMode === undefined ? null : 'Scratch'
    : null;
  useEffect(() => {
    let cancelled = false;
    if (!port.listProjects) { setProjects(null); return; }
    port.listProjects(spaceId).then(
      (next) => { if (!cancelled) setProjects(next); },
      () => { if (!cancelled) setProjects(null); },
    );
    return () => { cancelled = true; };
  }, [port, spaceId]);

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
      // An open chat is the anchor for its own staged files; a new one has
      // nothing to name yet and the file lands in the space library until
      // `chat.start` attaches it.
      start: attach
        ? (file: File) => (selectedRootId ? attach(file, selectedRootId) : attach(file))
        : undefined,
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
  /* The seed lands once per nonce (see `composerSeed`). The ref keeps the
     latest text without making the text itself a trigger. */
  const seedRef = useRef(composerSeed);
  seedRef.current = composerSeed;
  const seedNonce = composerSeed?.nonce;
  useEffect(() => {
    const seed = seedRef.current;
    if (seedNonce === undefined || !seed) return;
    let end = 0;
    setDraft((current) => {
      const sep = current === '' || /\s$/.test(current) ? '' : ' ';
      const next = `${current}${sep}${seed.text}`;
      end = next.length;
      return next;
    });
    const area = composer.current;
    if (!area) return;
    area.focus();
    /* After React writes the new value: a caret set before that commit is
       set on the old text and then reset by the value write. */
    const frame = requestAnimationFrame(() => area.setSelectionRange(end, end));
    return () => cancelAnimationFrame(frame);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [seedNonce]);
  /* "Start chat" hands the viewer the message box (§3.4): focus it once,
     after the opening read has put the composer on screen. */
  const seedFocusedRef = useRef(false);
  useEffect(() => {
    if (seedFocusedRef.current || !newChatSeedRef.current?.focus || loading) return;
    const area = composer.current;
    if (!area) return;
    seedFocusedRef.current = true;
    area.focus();
  }, [loading]);
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
  /** A new chat whose first send is in flight: the echo is on screen, so the
   *  composer has already left the centre (the dock-down plays on Send). */
  const birthing = newThread && detail !== null && detail.summary.rootId.startsWith(OPTIMISTIC_CHAT_PREFIX);
  const composerCentred = newThread && centre == null && !birthing;
  const wasCentredRef = useRef(composerCentred);
  useLayoutEffect(() => {
    const wrap = composerWrapRef.current;
    if (composerCentred) {
      emptyComposerTopRef.current = wrap?.getBoundingClientRect().top ?? null;
    } else if (wasCentredRef.current && (!newThread || birthing) && wrap && emptyComposerTopRef.current !== null) {
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
  }, [newThread, composerCentred, birthing]);
  const chatOccupiesCenter = centre === undefined || centre === null;
  /** The host's whole-root takeover: the workspace list panel, with its own
   *  search — so this screen's find box stands down for that root. */
  const hostedList = onChatsRoot ? null : (renderRootList?.(root) ?? null);

  const send = useCallback(async () => {
    const draftBody = draft.trim();
    if (draftBody === '' || busy || refusal || teammateId === '' || !selectedModel) return;
    /* The crew rides the opening turn (see `crewBrief`): visible before send,
       verbatim in the transcript. Only a NEW orchestrate chat has one. */
    const brief = newThread && chatMode === 'orchestrate'
      ? crewBrief(crew, { teammates, models, permission, options: modeOptions.orchestrate })
      : '';
    const body = brief ? `${draftBody}\n${brief}` : draftBody;
    const staged = attachmentsRef.current;
    // An upload still in flight is not a reason to drop it: Send waits rather
    // than posting a message whose file the writer is watching arrive.
    if (staged.blocked) return;
    const attachmentIds = staged.uploadedIds() as EntityId[];
    const continuingStoppedRoot =
      selectedRootId && phase === 'stopped-continuable' ? selectedRootId : null;
    setSubmitError(null);
    const originRoot = selectedRootId;
    /*
     * ── SEND PAINTS IN THE SAME FRAME ────────────────────────────────────────
     *
     * Reported by Subhang: "sending a message should immediately show the
     * agent's turn". The user's own words used to appear only after TWO round
     * trips — the post, then a whole thread re-read — with the composer still
     * holding them and nothing in the transcript but a "Sending…" row. Now the
     * words move from the composer into the transcript in the commit the press
     * causes (D12: at full weight, no "sending" watermark), and the turn's
     * clock starts, which is what mounts the agent's turn shell under them.
     * A failed submit takes the echo back out and returns the words to the
     * composer, exactly as they were typed (the raw draft, not the trim).
     */
    const clientMutationId = newMutationId(selectedRootId ? 'chat-turn' : 'chat-start');
    const echoId = optimisticTurnId(clientMutationId);
    const echo: ChatThreadDetail['turns'][number] = {
      messageId: echoId,
      role: 'user',
      author: null,
      createdAt: new Date().toISOString(),
      body,
      parts: [],
      optimistic: true,
    };
    const typed = draft;
    setDraft((current) => (current.trim() === draftBody ? '' : current));
    /* Keyed to the ORIGIN thread's slot (the setter closes over its
       `draftKey`), and it only fills an empty box — so it is safe to run
       whichever thread is on screen when the failure lands. */
    const restoreDraft = () => setDraft((current) => (current.trim() === '' ? typed : current));
    let acked = false;
    const priorClock = turnClockRef.current;
    try {
      if (selectedRootId) {
        stoppedRootRef.current = null;
        setPhase('posting-turn');
        setTurnClock(startTurnClock(selectedRootId, Date.now()));
        expectingRootRef.current = selectedRootId;
        expectingMarkRef.current = frameSeqRef.current;
        preTurnIdsRef.current = new Set(
          (detailRef.current?.turns ?? []).map((turn) => turn.messageId),
        );
        setDetail((current) => appendOptimisticTurn(current, selectedRootId, echo));
        const posted = await port.postTurn({
          chatId: selectedRootId,
          body,
          clientMutationId,
          ...(attachmentIds.length ? { attachmentIds } : {}),
        });
        acked = true;
        // Forget the chips WITHOUT cancelling their uploads: the ids are on
        // the message that was just stored.
        staged.clear();
        /* ACKED IS ENOUGH TO BE WAITING. The server has the turn; the re-read
           below only swaps the echo for the stored message, so the composer
           must not sit in "posting" for its round trip. */
        if (activeRootRef.current === selectedRootId) {
          setDetail((current) => settleOptimisticTurn(current, echoId, posted.messageId));
          setPhase(
            liveTurnsRef.current.size > 0 || expectingRootRef.current === selectedRootId
              ? 'streaming'
              : 'idle',
          );
        }
        const snapshot = await loadDetail(selectedRootId);
        // The user may have switched threads while the post was in flight —
        // this thread's snapshot must never overwrite another thread's screen.
        if (activeRootRef.current === selectedRootId) {
          setDetail((current) => reconcileDetails(current, snapshot));
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

      // ONE CALL NOW (176). This was post-then-configure: a message, then a
      // binding row keyed to it. `chat.start` creates the chat and posts its
      // opening turn in one transaction, so the intermediate `configuring`
      // phase — and the window it named, in which a message existed that was
      // not yet a chat — has nothing left to describe.
      setPhase('posting-root');
      /* A CHAT BEING BORN HAS NO ID YET, so the echo rides a stand-in thread
         keyed `optimistic-chat:…`. `selectedRootId` stays null until the ack,
         so nothing else — the select effect, the tray, the ledger stage —
         treats it as a conversation; only the transcript draws it. */
      const bornId = `${OPTIMISTIC_CHAT_PREFIX}${clientMutationId}` as EntityId;
      setTurnClock(startTurnClock(null, Date.now()));
      setDetail({
        summary: {
          rootId: bornId,
          aboutId: aboutId ?? null,
          /* D22: no title until the server names the chat — an empty header,
             never a guessed one that renames itself a beat later. */
          title: '',
          preview: '',
          updatedAt: echo.createdAt,
          replyCount: 1,
          config: {
            teammateId,
            teammateLabel: teammates.find((teammate) => teammate.id === teammateId)?.label ?? 'Agent teammate',
            model: selectedModel.model,
            modelLabel: selectedModel.label,
            mode: chatMode,
            workdirMode: projectBinding.workdirMode,
            projectId: projectBinding.projectId ?? null,
          },
          state: 'streaming',
        },
        turns: [echo],
      });
      const created = await port.startThread.create({
        spaceId,
        // `aboutId` replaces the anchor. Bare Home passes none; a contextual
        // host (Craft) passes the entity the chat is about, and the server
        // writes it as an `about` edge instead of anchoring the transcript on
        // somebody else's row.
        ...(aboutId ? { aboutId } : {}),
        body,
        /* The chat's title defaults to the opening body; with a crew brief
           appended that would name the chat after the brief. Name it after
           the human's own words instead. */
        ...(brief ? { title: draftBody.slice(0, 240) } : {}),
        teammateId,
        model: selectedModel.model,
        mode: chatMode,
        /* Write-once (167): offered in the empty state, locked after this. */
        workdirMode: projectBinding.workdirMode,
        ...(projectBinding.projectId ? { projectId: projectBinding.projectId } : {}),
        clientMutationId,
        ...(attachmentIds.length ? { attachmentIds } : {}),
      });
      if (
        created.teammateId !== teammateId ||
        created.model !== selectedModel.model ||
        created.mode !== chatMode
      ) {
        throw new Error('The node returned a different chat configuration than the one selected.');
      }
      acked = true;
      /* The next new chat's last-used mode, teammate and model (§3.4, §5).
         A host that pins its mode (Craft) is not the viewer choosing. */
      if (!pinnedMode) rememberChatStart({ mode: chatMode, teammateId, model: selectedModel.model });
      staged.clear();
      // The select effect owns loading the new chat — a second concurrent read
      // here would race it for setDetail/setPhase. `expecting` keeps the pulse
      // honest until the first frame arrives.
      expectingRootRef.current = created.chatId;
      expectingMarkRef.current = frameSeqRef.current;
      preTurnIdsRef.current = new Set();
      /* The stand-in becomes the chat, in the same commit as the selection —
         so the transcript never drops to the "reading" skeleton in between,
         and the select effect's first snapshot reconciles INTO it. */
      setDetail((current) =>
        current && current.summary.rootId === bornId
          ? settleOptimisticTurn(
              { ...current, summary: { ...current.summary, rootId: created.chatId } },
              echoId,
              created.messageId,
            )
          : current,
      );
      setTurnClock((current) => (current && current.chatId === null ? { ...current, chatId: created.chatId } : current));
      chooseRoot(created.chatId);
      onThreadSelected?.(created.chatId);
      setPhase('streaming');
      await refreshThreads(created.chatId);
    } catch (error) {
      /* THE WORDS COME BACK EVEN IF THE VIEWER LEFT. The box was cleared on
         Send, so a failure that lands after a thread switch must still return
         them — to the origin thread's draft, where they were typed. */
      if (!acked) restoreDraft();
      // Never let a failed send in one thread rewrite another's phase or show
      // its error under an unrelated conversation.
      if (activeRootRef.current === originRoot) {
        if (acked) return;
        // D12: the echo goes and the error says why.
        setDetail((current) =>
          current && current.summary.rootId.startsWith(OPTIMISTIC_CHAT_PREFIX)
            ? null
            : dropTurn(current, echoId),
        );
        /* OUR post failed; a turn already streaming in this thread did not.
           It keeps its phase and its clock. */
        const stillLive = liveTurnsRef.current.size > 0;
        setTurnClock(stillLive ? priorClock : null);
        expectingRootRef.current = null;
        preTurnIdsRef.current = null;
        if (continuingStoppedRoot) {
          stoppedRootRef.current = continuingStoppedRoot;
          setPhase('stopped-continuable');
        } else {
          setPhase(stillLive ? 'streaming' : 'idle');
        }
        setSubmitError(describeError(error));
      }
    }
  }, [
    aboutId,
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
    newThread, chatMode, crew, teammates, models, permission, modeOptions, projectBinding.workdirMode, projectBinding.projectId, pinnedMode,
  ]);

  const interrupt = useCallback(async () => {
    if (!selectedRootId || !port.interrupt) return;
    const rootId = selectedRootId;
    stoppedRootRef.current = rootId;
    // A Stop that takes seconds is itself a wait — the row says so.
    setTurnClock((current) => (current && current.chatId === rootId ? { ...current, stopping: true } : current));
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
        const ended = Date.now();
        setTurnClock((current) =>
          current && current.chatId === rootId ? { ...current, stopping: false, endedAt: ended } : current,
        );
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
        setTurnClock((current) => (current && current.chatId === rootId ? { ...current, stopping: false } : current));
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
                  {group.rows.map((thread) => withChatSubject(thread, onOpenEntity, (
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
                        <span>{thread.config.teammateLabel}</span>
                        <span aria-hidden>·</span>
                        <span>{thread.config.modelLabel}</span>
                        <Timestamp at={thread.updatedAt} />
                      </span>
                    </button>
                  )))}
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
            {/* THE `about` RELATION, where the conversation is (Wave 2).

                A chat's subject is an edge, and until now nothing drew it: a
                craft chat and a bare Home chat looked identical, and the one
                fact that distinguished them lived only in the graph. It is a
                CHIP rather than a word so the subject is reachable — the whole
                point of the relation is that it names something you can open.

                Drawn from `summary.aboutId`, which `readThread` fills for the
                chat actually on screen. The LIST does not carry it (see
                `ChatThreadSummary.aboutId`), so this renders once a thread is
                open and never flickers a wrong subject in from a stale row. */}
            {detail?.summary.aboutId ? (
              <div className="tch-about" data-testid="chat-about-relation">
                <span className="tch-about__word">about</span>
                <EntityChip
                  refInfo={{ id: detail.summary.aboutId }}
                  resolve={resolveEntity}
                  onOpen={onOpenEntity}
                />
              </div>
            ) : null}
            {/* THE CONTEXT NUMBER (Chat Context). A live frame is the runtime
                measuring right now; otherwise the stored reading, which is
                "last known" unless the runtime is still running. */}
            {detail
              ? (() => {
                  const live = liveContext.get(detail.summary.rootId);
                  const context = live ?? detail.summary.context ?? null;
                  if (!context) return null;
                  return (
                    <ChatContextNumber
                      context={context}
                      stale={live ? null : staleReason(detail.summary.runtimeState)}
                    />
                  );
                })()
              : null}
          </header>
        )}

        {centre != null ? (
          <section className="tch-center" aria-label="Selection" data-testid="tch-center-override">
            {centre}
          </section>
        ) : null}
        <div
          ref={follow.ref}
          className="tch-transcript"
          data-turn-phase={turnInProgress?.phase}
          aria-live="polite"
          data-hidden={centre != null ? 'true' : undefined}
          hidden={centre != null || undefined}
          /* Not a tab stop — only where "Jump to latest" puts focus back, so a
             keyboard reader is not dropped to <body> when the pill unmounts. */
          tabIndex={-1}
          /* THE READER'S INTENT, recorded on every scroll. Scrolling up to read
             back opts out of following a streaming answer; coming back within
             the tolerance opts straight back in. */
          onScroll={follow.onScroll}
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
              <LedgerHostProvider key={detail.summary.rootId} resolveEntity={resolveEntity} readEntity={readEntity} livenessOf={livenessOf} models={models}>
              {detail.turns.map((turn) => (
                <Turn
                  key={turn.messageId}
                  turn={turn}
                  mode={detail.summary.config.mode}
                  pending={turn.messageId === pendingTurnId}
                  live={turn.messageId === liveMessageId}
                  viewerId={viewerId}
                  onOpenEntity={onOpenEntity}
                  resolveEntity={resolveEntity}
                  suppressEntityIds={ownMessageIds}
                  assetHref={assetHref}
                  toolNote={toolNote}
                  /* One fold for the whole thread (cached on the turns array),
                     so a transition's from-side and a create's parent survive
                     turn boundaries — the same model the sticky projection
                     will render. */
                  ledger={foldChatLedger(detail.turns)}
                />
              ))}
              {shellTurn ? (
                <Turn
                  key="agent-turn-shell"
                  turn={shellTurn}
                  mode={detail.summary.config.mode}
                  pending
                  live
                  testId="chat-turn-shell"
                  viewerId={viewerId}
                />
              ) : null}
              </LedgerHostProvider>
              {/* THE LIVE STATUS ROW (lane 2), sticky under the last turn, and
                  the way back to it for a reader who scrolled up. It replaces
                  the wait row that only ever said "Agent is thinking…" — the
                  row now says what the agent is doing, for how long, and how
                  long it has been quiet, in every phase of the turn. */}
              <TranscriptDock
                turn={turnInProgress}
                parts={liveParts}
                labels={foldChatLedger(detail.turns).labels}
                away={follow.away}
                unseen={follow.unseen}
                onJump={follow.jumpToLatest}
              />
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
            newThreadIntro != null ? (
              <div className="tch-welcome tch-welcome--host">{newThreadIntro}</div>
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
            )
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
                  placeholder={newThread ? 'What are we doing?' : 'Type a message…'}
                  onKeyDownCapture={(event) => {
                    /* `/build` on an otherwise-empty input selects the mode. */
                    if (event.key !== 'Enter' || pinned || pinnedMode !== undefined) return;
                    const slashMode = modeFromSlash(draft);
                    if (!slashMode) return;
                    event.preventDefault();
                    event.stopPropagation();
                    setChatMode(slashMode);
                    setDraft('');
                  }}
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
                {/* ＋ = what this turn can DRAW ON (files, skills). The
                    typed `/` and the menu land in the same skill list. */}
                <AddToTurnMenu
                  {...(attach ? { onChooseFiles: attachments.addFiles } : {})}
                  {...(skillOptions ? { skillOptions } : {})}
                  enabledSkills={enabledSkills}
                  onToggleSkill={(id) =>
                    setEnabledSkills((current) =>
                      current.includes(id) ? current.filter((entry) => entry !== id) : [...current, id])}
                  {...(skillOptions ? { onBrowseSkills: () => rich.openTrigger('/') } : {})}
                />
                {enabledSkills.length ? (
                  <span className="tch-turnpills" data-testid="tch-turnpills">
                    {enabledSkills.map((id) => (
                      <button
                        key={id}
                        type="button"
                        className="tch-pill"
                        title="enabled for this turn — click to remove"
                        onClick={() => setEnabledSkills((current) => current.filter((entry) => entry !== id))}
                      >
                        /{skillOptions?.find((skill) => skill.id === id)?.display ?? id} <span aria-hidden>×</span>
                      </button>
                    ))}
                  </span>
                ) : null}
                {/* THE PER-TURN ROW: mode (loud) · teammate (face) · model+effort
                    (quiet) · one fixed ⚙ slot. Nothing here appears or
                    disappears when the mode changes (ac_12). */}
                <span className="tch-picks">
                  {/* A HOST-PINNED mode has no chip: the host IS the mode
                      (Craft is craft), so a held select that can never change
                      is noise on the row. A thread's own pin still shows it —
                      there the mode is a fact about the thread worth seeing. */}
                  {pinnedMode === undefined ? (
                    <ComposerSelect
                      label="Chat mode"
                      testId="tch-mode"
                      options={modeSelectOptions}
                      emphasisGroups={['Act']}
                      tall
                      value={shownMode}
                      onChange={(id) => setChatMode(id as ChatMode)}
                      disabled={pinned}
                      emptyNote="No chat mode is available."
                    />
                  ) : null}
                  <ComposerSelect
                    label="Chat teammate"
                    testId="tch-teammate"
                    options={teammateOptions}
                    value={shownTeammateId}
                    onChange={(id) => setTeammateId(id as EntityId)}
                    disabled={pinned}
                    emptyNote="No agent teammate is available in this space."
                    note={roster.note}
                  />
                  <ModelEffortPicker
                    label="Chat model"
                    testId="tch-model"
                    className="tch-pick--model"
                    models={models}
                    choices={modelChoices}
                    value={shownModelId}
                    onChange={setModelId}
                    effort={effort}
                    onEffortChange={(next) => setEffortByMode((current) => ({ ...current, [shownMode]: next }))}
                    disabled={pinned}
                    disabledReason="the model is fixed when a thread starts"
                  />
                  <ModeOptionsSlot
                    mode={shownMode}
                    values={modeOptions[shownMode]}
                    onChange={(values) => setModeOptions((current) => ({ ...current, [shownMode]: values }))}
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
            {/* UNDER THE COMPOSER = THIS THREAD. Quieter than the row; stays
                in place after the first send and compacts (the project locks,
                permissions stays live). The conflict strip sits in the gap. */}
            <ThreadRail
              projects={projects}
              projectChoice={projectChoice}
              onProjectChange={setProjectChoice}
              projectLocked={pinned}
              lockedProjectLabel={lockedProjectLabel}
              permission={permission}
              onPermissionChange={setPermissionChoice}
              permissionSource={permissionSource}
              conflict={conflict}
            />
            {newThread && shownMode === 'orchestrate' ? (
              <CrewPanel
                crew={crew}
                onChange={setCrew}
                teammates={teammates}
                models={models}
                permission={permission}
                policy={modeOptions.orchestrate}
                {...(skillOptions ? { skillIds: skillOptions.map((skill) => ({ id: skill.id, label: skill.display })) } : {})}
              />
            ) : null}
          </div>
        )}
      </section>
    </main>
  );
}


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
  live,
  testId,
  viewerId,
  onOpenEntity,
  resolveEntity,
  suppressEntityIds,
  assetHref,
  ledger,
  toolNote,
}: {
  turn: ChatThreadDetail['turns'][number];
  mode: ChatMode;
  /** This turn is the one the pulse is already announcing. */
  pending?: boolean;
  /** This is the agent turn in progress — the shell, or the real message
   *  while it streams. */
  live?: boolean;
  testId?: string;
  viewerId?: string | undefined;
  onOpenEntity?: ((id: EntityId) => void) | undefined;
  resolveEntity?: ChatEntityResolver | undefined;
  suppressEntityIds?: ReadonlySet<string> | undefined;
  assetHref?: ((fileEntityId: EntityId) => string | null) | undefined;
  /** The whole thread's ledger fold, for cross-turn memory in the lines. */
  ledger?: ChatLedger | undefined;
  toolNote?: TurnPartsProps['toolNote'];
}) {
  const label = (turn.author ? actorName(turn.author) : null) ?? (turn.role === 'assistant' ? 'Agent' : 'You');
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
  /**
   * THIRD PARTY — this turn was written from SOMEWHERE ELSE.
   *
   * A chat is a routing target since 176, so a message here may have been
   * posted by a work session reporting back, or by another chat. Neither is
   * the person this conversation is with, and neither is its agent — but the
   * AUTHOR cannot tell them apart: a session's persona resolves to the same
   * `team_member` summary the chat's own agent carries. The port reads the
   * `authored_from` edge instead and drops the chat's own id (its agent turns
   * carry provenance too, pointing at the chat), so presence here means
   * exactly "not from this conversation".
   *
   * IT OVERRIDES SIDEDNESS. A third-party turn is `role: 'user'` and, with no
   * `viewerId` supplied, the role heuristic would land it on the viewer's own
   * side — a worker's report drawn as something you said. Neither side is
   * right for it, so it renders in the middle lane and says who sent it.
   */
  const thirdParty = turn.sourceEntityId != null;
  const isSelf = thirdParty
    ? false
    : viewerId
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
    <article
      className="tch-turn"
      data-role={turn.role}
      data-mode={mode}
      data-self={isSelf ? 'true' : 'false'}
      data-third-party={thirdParty ? 'true' : undefined}
      data-live={live ? 'true' : undefined}
      aria-busy={live || undefined}
      data-testid={testId}
    >
      <header className="tch-turn__byline">
        <Avatar
          actorId={actorId}
          provenance={agent ? 'agent' : 'human'}
          label={label}
          size={20}
          src={turn.author?.avatar}
        />
        <strong>{label}</strong>
        {/* THE SOURCE, AS A CHIP — the same `EntityChip` a tool call's entity
            reference gets, resolving kind mark and title through the same
            cached reader. A bare id would say "this came from elsewhere"
            without saying from where, which is the half of the fact that
            matters when a worker reports into a chat you are watching. */}
        {turn.sourceEntityId ? (
          <span className="tch-turn__source" data-testid="chat-turn-source">
            <span className="tch-turn__source-word">via</span>
            <EntityChip
              refInfo={{ id: turn.sourceEntityId }}
              resolve={resolveEntity}
              onOpen={onOpenEntity}
            />
          </span>
        ) : null}
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
        toolNote={toolNote}
        /* One source of truth for which turn is live (L1's turn-in-progress,
           which also drives `aria-busy`): every other turn is over, and a call
           it left `running` reads as stopped — a runtime that died never
           closes the calls it abandoned. */
        settled={!live}
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

/** The error a turn ended with, from its not-yet-pruned deltas or its merged
 *  parts; `null` for a turn that ended cleanly. */
function turnFailureOf(
  messageId: EntityId,
  frames: readonly ChatTurnFrame[],
  detail: ChatThreadDetail | null,
): string | null {
  const parts = [
    ...(detail?.turns.find((candidate) => candidate.messageId === messageId)?.parts ?? []),
    ...frames.flatMap((frame) =>
      frame.type === 'chat.turn.delta' && frame.messageId === messageId ? [frame.part] : []),
  ];
  const error = [...parts].reverse().find((part) => part.kind === 'error');
  const message = error?.kind === 'error' ? error.message : 'The turn failed.';
  /* The terminal `done` part names HOW the turn ended; when it is here it is
     the authority. Without it (an older node), an error part is the tell. */
  const done = parts.find((part) => part.kind === 'done' && part.reason !== undefined);
  if (done?.kind === 'done') return done.reason === 'error' ? message : null;
  return error ? message : null;
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

/** The stand-in id a new chat's transcript carries until `chat.start` acks. */
const OPTIMISTIC_CHAT_PREFIX = 'optimistic-chat:';

/** The phases in which the agent's turn is still coming — the shell stands. */
const SHELL_PHASES = new Set(['sending', 'waiting', 'streaming', 'stopping']);

/** The agent turn shell: the chat's own teammate, no body, no parts. */
function agentShellTurn(detail: ChatThreadDetail, startedAt: number): ChatThreadDetail['turns'][number] {
  const { teammateId, teammateLabel } = detail.summary.config;
  return {
    messageId: 'agent-turn-shell' as EntityId,
    role: 'assistant',
    author: { id: teammateId, kind: 'team_member', displayName: teammateLabel, isAgent: true },
    createdAt: new Date(startedAt).toISOString(),
    body: '',
    parts: [],
  };
}

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

/**
 * A Chats-list row, with its SUBJECT when the server named one (entity chat
 * §3.6): "about ‹title›" as a chip that opens the subject, not the chat.
 *
 * The chip sits BESIDE the row button rather than inside it — a button cannot
 * nest a button, the `.tch-task-row` precedent. A row with no subject (or from
 * a port that predates §3.6) is returned exactly as it was.
 */
function withChatSubject(
  thread: ChatThreadSummary,
  onOpenEntity: ((id: EntityId) => void) | undefined,
  row: ReactNode,
): ReactNode {
  if (!thread.about) return <Fragment key={thread.rootId}>{row}</Fragment>;
  const { id, kind, title } = thread.about;
  return (
    <div key={thread.rootId} className="tch-chat-row" data-testid="chat-row-with-subject">
      {row}
      <div className="tch-thread__about" data-testid="chat-row-about">
        <span className="tch-about__word">about</span>
        <EntityChip refInfo={{ id, kind, title }} onOpen={onOpenEntity} />
      </div>
    </div>
  );
}
