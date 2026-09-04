import { useEffect, useRef, useState, type ReactNode } from 'react';
import type {
  CommandResult,
  Connections,
  EntityDetail,
  HandoffView,
  MessageView,
  TrackingPrMergeResult,
  WorkSessionInteractionProfileProjection,
} from '@tm8/contract';
import type { SessionLiveness } from '../data/seam';
import { useMobileSurface } from '../mobile';
import type { ContentSurface } from '../routes';
import type { ActionContext, ActionRef, ContentBlockRef, KindConfig } from '../domain';
import { getKind, newLaunchMutationId, resolveAction } from '../domain';
import { LaunchQuickConfig } from './launch/LaunchQuickConfig';
import type { LaunchSources } from './EntityListPanel';
import {
  AuthoringHost,
  SaveControls,
  useTaskSave,
  type AuthoringCommands,
  type TaskSaveHandle,
} from '../authoring';
import {
  ActionBar,
  PanelFooter,
  PanelHeader,
  PanelWindowControls,
  TabStrip,
  panelActionContext,
  type PanelHost,
  type PanelTab,
} from './detail/chrome';
/*
 * THE CHIP BAND'S PHONE GEOMETRY — a separate stylesheet, imported by the
 * component that renders `.pn-controls`, for the coordination reason
 * `panel-bar-phone.css` states at length: `panels.css` is shared and has lane
 * work in flight in it, and one file per change is how this program avoids a
 * shared-file merge conflict. Every rule inside is scoped
 * `.cv2-root[data-shell='mobile']`.
 */
import './detail/panel-controls-phone.css';
import {
  ErrorBody,
  LoadingBody,
  PermissionLostPanel,
  StalePinBanner,
  TombstoneBody,
} from './detail/PanelStates';
import { ConnectionsTab } from './detail/tabs';
import { CatchBoundary } from './detail/CatchBoundary';
import {
  EntityControlStrip, stripHasLiveControl, type ControlHost, type ControlSubject,
} from './controls/EntityControls';
import { GenericBody, type ArtifactPreviewCommands } from './bodies/GenericBody';
import { TerminalBody } from './bodies/TerminalBody';
import { SubtreeBody } from './bodies/SubtreeBody';
import { ReaderSurface } from './bodies/ReaderSurface';
import type { DocCommands } from '../doc-edit';
import { HubBody } from './bodies/HubBody';
import { ProfileBody, type MemoryAuthoring } from './bodies/ProfileBody';
import type { MembershipAuthoring } from './bodies/MembershipBlock';
import type { MemoryMarkKind } from '../domain/memory';
import { GovernedBody } from './bodies/GovernedBody';
import { RestrictedBody } from './bodies/RestrictedBody';
import { WorkSessionContent } from './bodies/WorkSessionContent';
import { AttachmentStrip } from '../files/AttachmentStrip';
import { attachedFiles } from '../files/model';
import type { AttachmentsPort } from '../files/port';
import type { TriggerOption } from '../rich-input';
import { LinkedPullRequestChips, pullRequestFactsOf, type LinkedPullRequestFacts } from '../pull-requests';
import { TransferControl } from '../transfer';
import { MergePullRequestFlow } from './pull-requests/MergePullRequestFlow';
/* T3 owns this stylesheet: every rule is subtree-archetype scoped, keeping the
   premium task surface out of the shared list/navigation CSS merge lanes. */
import './task-detail.css';

/**
 * EntityDetailPanel — one of the two universal primitives (L3).
 *
 * ONE COMPONENT RENDERS EVERY KIND. The anatomy is fixed (header → action bar
 * → tabs → footer); the ONLY per-kind region is the Content body, and which
 * body that is comes from `registry(kind).panel.archetype` — registry DATA.
 * There is no `kind ===` anywhere in this file, and there cannot be: §15.2
 * fails the build on one.
 *
 * THREE TABS ALWAYS — Content · Connections · Discussion, fixed order, every
 * kind, no exceptions (user ruling 2026-08-19; see `PANEL_TABS` for why
 * Connections leads and why Activity was removed). It costs almost nothing
 * because two of the three are kind-agnostic by construction (detail/tabs.tsx).
 *
 * THE SAME INSTANCE SERVES EVERY HOST. `host` ('stack' | 'pinned' | 'peek' |
 * 'z4') changes width and chrome only — never anatomy — so a panel is the
 * same recognisable object in the peek stack, a pinned column and full view.
 *
 * A1 SCOPE: the `terminal` archetype is fully built (it is the gate's session
 * panel); the other five archetypes render the GENERIC body over their
 * registry blocks. The archetype-specific bodies (subtree, reader, hub,
 * profile) are A2 fan-out — they slot in at the one switch below without
 * touching the chrome, which is the whole point of the anatomy being fixed.
 */

/**
 * When an archetype has no dedicated body yet, render its real scalar content
 * rather than a placeholder. An honest partial beats a "coming soon".
 */
const DEFAULT_BLOCKS: readonly ContentBlockRef[] = [{ block: 'fields' }];

/**
 * The narrowest panel that can seat a `composition: 'frame'` body's controls in
 * the panel bar without the tab labels paying for them — see `barHasRoom`.
 *
 * ADDED UP FROM MEASUREMENTS, not chosen: the three tabs want 233px and the end
 * cluster with the viewer's controls in it is 278px. `.pn-panelbar` adds no
 * padding of its own (measured: 280 + 278 = 558 = the panel's whole width), so
 * 511 — rounded to 520. Below it the block keeps its controls and spends a row
 * on them, the arrangement it had before the bar existed.
 *
 * IT IS AN UNZOOMED NUMBER, and that is the whole reason this comment is long.
 * `.cv2-root` carries a CSS zoom, so `getBoundingClientRect` comes back SCALED
 * while `offsetWidth`/`clientWidth`/`scrollWidth` do not — the same panel reads
 * 616 one way and 558 the other. Every part width above is an `offsetWidth`, and
 * `ResizeObserver`'s `contentRect` is in that same unzoomed system, which is why
 * `barHasRoom` observes rather than measuring a rect. A threshold compared
 * against a rect is wrong by the zoom factor, in the direction that silently
 * keeps the controls in a bar too narrow to hold them.
 */
const FRAME_CONTROLS_MIN_PANEL_PX = 520;

/**
 * Does this kind declare anything for the strip to draw?
 *
 * REGISTRY DATA, NOT A KIND LIST. A doc declares none of the three and gets no
 * strip; a task declares all three and gets all three; a kind that grows a
 * second `ValueControl` tomorrow gets it here with no edit to this file. The
 * archive verb alone is NOT enough to mount the strip — every kind has a
 * tombstone, so keying on that would put a bare Archive bar under every panel
 * in the app, which is a redesign and not this fix.
 *
 * AND NEITHER IS AN OBSERVED STATE — USER RULING 2026-08-06, on the session
 * panel: remove the bar above the terminal. A `stateControl` carrying
 * `readOnlyReason` is a state the node REPORTS, not one a user authors; drawn
 * in the strip it is a badge that looks like a control, sitting next to an
 * Archive the panel is not otherwise asking for. The session's status is
 * already in the header pill — and there it carries the LIVENESS verdict the
 * strip's copy never had (`StatusPillFor`), so the band was the less truthful
 * of the two renderings as well as the more expensive one.
 *
 * This is still registry data and still no archetype gate: a kind whose state
 * becomes authorable gets its band back by dropping `readOnlyReason`.
 */
function controlsFor(config: KindConfig): boolean {
  const list = config.list;
  return (
    (list.stateControl !== undefined && list.stateControl.readOnlyReason === undefined) ||
    (list.valueControls?.length ?? 0) > 0 ||
    list.assignControl !== undefined
  );
}

/**
 * Project an `EntityDetail` onto the subset the controls read.
 *
 * The two shapes already agree member for member — this exists so the port
 * stays a SUBSET rather than growing an `EntityDetail` dependency, and so the
 * compiler checks the projection instead of a cast hiding a renamed field.
 */
function subjectOf(detail: EntityDetail): ControlSubject {
  return {
    id: detail.id,
    title: detail.title,
    kind: detail.kind,
    state: detail.state,
    /* The content, because the panel HAS it — the one subject in the app
       that does. A number value control (points) reads its current value
       from here; list hosts pass summaries, which carry none, and their
       copy of that control refuses with the value-unreadable reason. */
    content: detail.content,
    deletedAt: detail.deletedAt,
    /* Which tab this row is under. `terminate` refuses itself on a row that
       has already ended, and the LIST hosts get this for free because they
       pass an `EntitySummary` straight through — this hand-built subject is
       the one place that has to say it. */
    category: detail.category,
  };
}

export interface DetailReasons {
  /** D7.2 — presence is measured-empty; the viewers footer is hollow. */
  presenceHollow: string;
  /** R7 — version history is deferred; `v{n}` is its disabled home. */
  versionHistory: string;
  /** D7.3 — `authored_from` is null until backend S2. */
  provenanceHollow: string;
  /** §10.7 — handoffs.send is not in the stamped seam. */
  shareUnavailable: string;
  /** §10.7 — handoffs.withdraw is not in the stamped seam. */
  withdrawUnavailable: string;
}

/**
 * What the merge confirm needs from its host. Three fields, and two of them
 * are optional BECAUSE THEY ARE OFTEN GENUINELY UNKNOWN — the flow's copy
 * changes to say so rather than printing a placeholder.
 */
export interface MergePrSources {
  /** Commits the merge through the seam. */
  onMerge: (entityId: string, input: { headSha?: string }) => Promise<TrackingPrMergeResult>;
  /**
   * The head the viewer was shown, if this host has one. NO CLIENT READ
   * PROJECTS A PR'S HEAD SHA TODAY (the column is stored but never surfaced),
   * so absent is the honest normal case: the flow then omits `headSha` and the
   * server pins the head it stored — the row the human reviewed.
   */
  headShaFor?: (entityId: string) => string | null;
  /** The viewer's GitHub login, for attribution. Null ⇒ not known here. */
  githubLogin?: string | null;
}

export interface EntityDetailPanelProps {
  detail?: EntityDetail | null;
  /** Same-origin route prefix for the tm8 server hosting this entity. */
  serverBaseUrl?: string;
  host?: PanelHost;
  breadcrumb?: string;
  reasons: DetailReasons;
  ctx: ActionContext;

  /** Panel states. `permissionLost` replaces the WHOLE panel — see below. */
  loading?: boolean;
  error?: string | null;
  permissionLost?: boolean;
  /** A pinned panel whose pulled version has drifted from live content. */
  stalePin?: { pinnedVersion: number; liveVersion: number };

  /** Tab data. Absent ⇒ that tab renders its designed empty state. */
  messages?: readonly MessageView[];
  connections?: Connections;
  authoredFrom?: Readonly<Record<string, string | null>>;
  /** Observer-backed PR facts linked to this subject by tracking edges. */
  linkedPullRequests?: readonly LinkedPullRequestFacts[];
  /**
   * The same facts BY ID, for rows this panel draws about OTHER entities —
   * today the membership block's member tiles, which carry the same PR chips
   * their own list gives them. Absent ⇒ tiles render without chips, exactly
   * like a list whose host wired none.
   */
  linkedPullRequestsOf?: (id: string) => readonly LinkedPullRequestFacts[];

  /** work_session inputs — ignored by every other archetype. */
  handoffs?: readonly HandoffView[];
  liveness?: SessionLiveness;
  /** Verdicts for RELATED session rows (SubtreeBody RUNS, ProfileBody RECENT
      SESSIONS) — same seam source as `liveness`, per-id. Optional: an absent
      map renders those rows' liveness as unverified, never as live. */
  livenessOf?: (id: string) => SessionLiveness;
  /**
   * Working-set authoring for the `memory-set` block (056/084/085). Absent ⇒
   * the block renders the set READ-ONLY rather than drawing dead controls; the
   * panel does not perform the writes itself, it only forwards the intent.
   */
  memoryAuthoring?: MemoryAuthoring | null;
  /**
   * Collection-membership authoring for the `membership` block (migration
   * 100). Same intent-only contract as `memoryAuthoring`: absent ⇒ the block
   * renders read-only rather than drawing dead controls.
   */
  membershipAuthoring?: MembershipAuthoring | null;
  /**
   * Begin a `supersedes`/`disputes` mark against the open memory (056 §5).
   * Absent ⇒ the `epistemics` block states that marking is unwired rather than
   * hiding the verbs, which would claim the memory cannot be marked.
   */
  onMarkMemory?: ((mark: MemoryMarkKind) => void) | null;
  /** The composer's dispatcher — absent ⇒ composer disabled-with-reason. */
  /**
   * THE TRIGGER SUBJECTS, for every rich input this panel mounts — the
   * Discussion composer's `@` and `/`, and the doc editor's `/`.
   *
   * `undefined` means the capability is ABSENT and the sigil types as plain
   * text; `[]` is a measured zero and keeps the picker able to say so. The
   * panel holds no seam of its own, so a host that has one wires these and a
   * host that does not gets an input which is honest about what it can do —
   * which is the whole reason the Discussion placeholder could advertise an
   * `@` that was never implemented.
   */
  mentionOptions?: readonly TriggerOption[];
  skillOptions?: readonly TriggerOption[];
  /**
   * Resume this exited/failed work session. Absent ⇒ the exited card renders
   * its Resume button DISABLED with a reason, never hidden — a missing button
   * would claim the session is unresumable rather than unwired.
   */
  onResumeSession?: () => void;
  /** True while that resume is in flight. */
  resumingSession?: boolean;
  /**
   * Record a STALE session as exited — the record says running, liveness says
   * no PTY. Absent ⇒ the stale card renders its chip DISABLED with a reason,
   * on the same L6 grounds as `onResumeSession`: a hidden chip would claim the
   * session cannot be cleared rather than that this surface cannot clear it.
   */
  onMarkSessionExited?: () => void;
  streaming?: boolean;
  needsAttention?: boolean;
  attentionDetail?: string;
  /** Viewer-local presentation state for the work-session Content panes. */
  contentSurface?: ContentSurface | null;
  viewerMemberId?: string | null;
  /**
   * The CONVERSATION surface — composed by the host via `conversationSurfaceFor`
   * and mounted by two structurally different arms: the session panel's
   * Transcript pane and a hub's feed. Named for the slot rather than its
   * occupant, which is what let the session panel repoint from chat to
   * transcript without touching a single host.
   */
  conversationSurface?: ReactNode;
  /**
   * THE DISCUSSION TAB'S CONVERSATION. Same host contract as every other
   * seam-backed surface here: the panel is presentational and cannot reach a
   * feed, so the host composes it through `conversationSurfaceFor(…, 'discussion')`
   * and hands it in. `panel-host-wiring.test.ts` asserts all five hosts do.
   *
   * It replaces the tab's own renderer and composer, which read `messages.list`
   * — the `anchored` predicate ALONE, and without paging. On a session that is
   * a strict subset of what the same conversation showed one tab over, and it
   * was the always-visible one.
   */
  discussionSurface?: ReactNode;
  /** The DEBUG surface (session CLI journal). Self-fetching; host wires the seam. */
  debugSurface?: ReactNode;
  /** The GIT surface (worktree status/diff/verbs rail). Same contract as Debug. */
  gitSurface?: ReactNode;
  /** The task detail's git section (tracked PRs/commits + gate verdict). */
  taskGitSection?: ReactNode;
  /** The GRAPH surface (what the session is connected to). Same contract as Debug. */
  graphSurface?: ReactNode;
  /**
   * THE EXITED SESSION'S POST-MORTEM — tokens, messages, tools, models and the
   * files it touched, read from the agent's own transcript. Same contract as
   * Debug: self-fetching, host wires the seam (`views/sessionStatsSurface.tsx`).
   *
   * It lands INSIDE the terminal archetype's canvas rather than in a tab of its
   * own, because the slot it fills is the one the ended session already owns:
   * the fallback that until now said "Session exited" and nothing else. A host
   * that passes nothing gets exactly that screen back, unchanged.
   */
  sessionStatsSurface?: ReactNode;
  /**
   * ATTENTION HISTORY — every request ever escalated on this entity, settled or
   * not. Self-fetching; the host wires the seam (`views/attentionSurface.tsx`).
   *
   * ONE PROP FOR EVERY KIND, like `attachments` and for the same reason:
   * `attention_requests.entity_id` references `entities`, so the server will
   * flag any kind at all and a per-kind prop would be a restriction the backend
   * does not have.
   *
   * IT MOUNTS IN TWO PLACES, which is the one thing here that is not uniform.
   * Most archetypes take it inline in the Content body. The terminal archetype
   * and `composition:'chat'` cannot — a live PTY owns its full height and a
   * chat body ends at its composer, the same two structural exclusions the
   * attachment strip carries — so for those it rides the CONNECTIONS tab
   * instead (user ruling 2026-08-16; it rode the Activity tab until that tab
   * was removed on 2026-08-19). Excluding them outright was the alternative
   * and was rejected: work sessions are among the most-escalated entities in a
   * space, and their history would have been CLI-only.
   *
   * Absent ⇒ nothing renders. The section is invisible on any entity with no
   * history anyway, so an unwired host leaves no dangling affordance to explain.
   */
  attentionSection?: ReactNode;
  /**
   * ATTACHMENTS — bytes and an uploader for the strip in the Content body.
   *
   * ONE prop for every kind, deliberately: `attached_to` is an edge type and
   * the server attaches a file to any entity id at all, so a per-kind prop
   * would be a restriction the backend does not have. Absent ⇒ the strip
   * renders read-only if the entity already has attachments and renders
   * NOTHING if it has none — no dead dropzone, no empty box.
   *
   * `AttachmentsPort` is a structural port over the seam (`files/port.ts`), so
   * a host writes `attachmentsPortFromSeam(seam, spaceId)` and nothing else.
   */
  attachments?: AttachmentsPort | null;
  /** An upload landed; the host refetches so the new edge appears. */
  onAttachmentUploaded?: () => void;
  onContentSurfaceChange?: (surface: ContentSurface) => void;

  /**
   * THE EXECUTOR FOR EDITS. Absent ⇒ every save affordance on a kind that CAN
   * be edited renders disabled-with-reason ("saving is not wired here"),
   * which is L6: the control is visible, dead, and says why. It is never a
   * live-looking title that swallows keystrokes.
   *
   * `AuthoringCommands` is a structural subset of `Seam['commands']`, so a
   * host assigns `seam.commands` with NO cast and no adapter — an adapter
   * being precisely where an argument gets dropped (D57.1).
   *
   * `patchEntity` rides along as OPTIONAL rather than required because the two
   * flows are genuinely different commands: `patchTask` writes a task's state
   * axes, `patchEntity` writes a doc's title and body. `Seam['commands']`
   * carries both, so every real host assigns it unchanged; a host that wires
   * only the task half gets a reader panel whose `Edit` is
   * disabled-with-reason, which is the honest report of what it wired.
   */
  commands?: (AuthoringCommands & Partial<DocCommands> & Partial<ArtifactPreviewCommands>) | null;
  /** A save landed. The durable event carries only a summary, so the host
      must receive this result to reconcile heavy detail fields such as the
      task description into its detail cache. */
  onSaved?: (result: CommandResult) => void;
  /** Conflict resolution chose TAKE THEIRS and the node handed back its
      detail. Optional because the event stream has already put their version
      in the store — this is the host's chance to do more than that. */
  onReloadDetail?: (current: EntityDetail) => void;
  /** This id was just created by the ＋ New flow: open with the title focused
      ("Z3 opens, title in inline-edit focus"). */
  justCreated?: boolean;

  /**
   * THE CONTROL STRIP'S HOST — state, priority and assignment on the panel.
   *
   * THE SAME `ControlHost` THE LIST PASSES, and the same components behind it.
   * Before this prop existed the panel drew `status` as a read-only header
   * pill and `priority` / `assignees` as `<span>`s in the meta grid, so the
   * surface the generic-create pattern opens the instant you press "+ New
   * task" was the one surface where none of the three could be set. That is
   * the reported defect ("while creating a task I am not able to assign, edit
   * priority"), and it is fixed by MOUNTING the existing controls rather than
   * by growing a third copy of them (`controls/EntityControls.tsx` carries the
   * full argument).
   *
   * Absent ⇒ the strip still renders and every control refuses with
   * "not wired here". A missing host is never a hidden control: hiding it
   * would claim the kind has no state to set, which is a different fact.
   */
  controls?: ControlHost | null;
  /**
   * Undo the tombstone. Absent ⇒ the tombstone's Restore button renders
   * DISABLED with a reason instead of enabled-and-inert — it was the latter
   * for the whole of this panel's life, because `TombstoneBody` has always
   * drawn the button and nothing ever passed the handler. An archived task
   * therefore had no way back, which is the second half of the reported
   * defect ("after a task is archived I am not able to move it to open").
   */
  onRestore?: () => void;

  activeTab?: PanelTab;
  onTabChange?: (tab: PanelTab) => void;
  pinned?: boolean;
  pinRefusal?: string;
  onPin?: () => void;
  onPromote?: () => void;
  onClose?: () => void;
  /**
   * THE EXECUTOR FOR PANEL PRIMARIES — Terminate, and every other verb the
   * registry names in `panel.primaries` that commits directly.
   *
   * Absent ⇒ the action bar renders those verbs DISABLED-WITH-REASON rather
   * than enabled-inert (R5 #9). It was absent at EVERY one of this panel's
   * five mounts for the whole of its life, which is the reported defect: the
   * Terminate button above a live terminal, and Run on a task, were drawn and
   * permanently greyed out. The verbs and their executors both existed; only
   * this prop was missing.
   */
  onAction?: (ref: ActionRef) => void;
  /**
   * Which primaries `onAction` can actually perform. Absent ⇒ all of them.
   * A host that wires Terminate and has no `add-child` executor names the one
   * it has, and the other keeps its honest refusal. See `ActionBar`.
   */
  wiredActions?: readonly ActionRef[];
  /**
   * THE LAUNCH SOURCES for Run's inline configuration — the SAME `LaunchSources`
   * the list panel takes, so the two surfaces cannot drift into two different
   * spawn semantics.
   *
   * Run does not commit on click: it carries `flow: 'launch'` in registry data,
   * so it expands the config and the config commits. That makes it independent
   * of `onAction` — a host with launch sources and no dispatcher still has a
   * working Run. Absent ⇒ Run falls back to the disabled-with-reason path.
   */
  launch?: LaunchSources | null;
  /**
   * THE FORGE WRITE DOOR for `Merge…` (B10), shaped like `launch`: the verb
   * carries `flow: 'merge-pr'` in registry data, so it expands the confirm and
   * the confirm commits. Absent ⇒ Merge falls back to the disabled-with-reason
   * path, exactly as Run does without launch sources.
   *
   * A HOST WIRES THIS FOR EVERY KIND; the flow renders only when the subject
   * actually reads as a pull request, which `pullRequestFactsOf` decides from
   * the row's own shape. No kind literal enters this file (§15.2).
   */
  mergePr?: MergePrSources | null;
  onOpenEntity?: (id: string) => void;
  onRetry?: () => void;
}

export function EntityDetailPanel(props: EntityDetailPanelProps) {
  /* DEF-004 — see the `onOpenLaunch` spread on the ActionBar below. Read from
     the host's context and never from the window: `GateApp` has already made
     the shell decision once. `false` on every desktop path by construction. */
  const { oneSurface } = useMobileSurface();
  const {
    detail,
    host = 'stack',
    breadcrumb,
    reasons,
    ctx,
    loading,
    error,
    permissionLost,
    stalePin,
    activeTab,
    onTabChange,
    onClose,
  } = props;

  const [uncontrolledTab, setUncontrolledTab] = useState<PanelTab>('content');
  /*
   * THE PHONE'S BODY IS ALWAYS THE CONTENT TAB — user ruling 2026-08-20.
   *
   * With the strip gone there is no way to SELECT connections or discussion as
   * a body on this shell, and they are not meant to be one: both already open
   * as a `MobileSheet` over the panel (`EntityView`'s aux column), which is the
   * arrangement the ruling improves rather than rebuilds.
   *
   * CLAMPED HERE RATHER THAN AT THE HOST, because `activeTab` is a CONTROLLED
   * prop and `EntityView` drives it from state shared with the desktop. A host
   * whose `onTabChange` routes both aux tabs to a sheet can still leave
   * `activeTab` holding one of them — a back press, a restored route, a second
   * mount — and the body would then render a Connections list UNDER the sheet
   * showing the same connections. The clamp reads the arrangement, so no host
   * has to remember it.
   */
  const tab: PanelTab = oneSurface ? 'content' : (activeTab ?? uncontrolledTab);

  /**
   * USER RULING 2026-07-31 — the [ TERMINAL | CHAT ] switch belongs on the top
   * row's right edge, not on a row of its own above the canvas. The panel bar
   * is rendered here and the switch is owned by WorkSessionContent two levels
   * down, so the bar publishes an empty slot NODE and the body portals into
   * it. A callback ref into STATE, not a plain ref: the portal target has to be
   * a rendered value, and a ref mutation would not re-render the body, so the
   * slot would sit empty until something unrelated happened to update.
   *
   * ABOVE EVERY EARLY RETURN, for the reason the save flow below states — hooks
   * do. Placed next to the archetype check it serves, this was a live React
   * #310 the moment a permission-lost or detail-less panel rendered first.
   */
  const [surfaceSlot, setSurfaceSlot] = useState<HTMLDivElement | null>(null);

  /**
   * IS THERE ROOM IN THE BAR FOR THE FRAME'S CONTROLS? — measured, not assumed.
   *
   * `.pn-tabs` is the only flexible child of `.pn-panelbar` and its scrollbar is
   * hidden, so anything the end cluster takes is paid for by the TAB LABELS with
   * nothing on screen saying it happened. MEASURED in Chrome on the artifact
   * panel: the cluster goes 102px → 278px when the viewer's controls join it,
   * and the three tabs need 233px. At a 616px panel that fits with room to
   * spare; at a 428px one it does not, and Connections and Discussion are
   * scrolled clean out of the document view.
   *
   * So the panel decides, from its own width, and the block DEGRADES: with no
   * slot it draws the controls in place above the frame, which is one ~34px row
   * — a fair price for a panel that can still be navigated. That fallback is the
   * same path a fixture or the dev harness takes, so it is the tested one rather
   * than a special case invented here.
   *
   * A MEASUREMENT AND NOT A MEDIA QUERY, because the panel is a column inside a
   * stack: its width is a layout outcome, not the viewport's. Two panels of
   * different widths can be on screen at once and a media query would give them
   * the same answer.
   */
  const [panelEl, setPanelEl] = useState<HTMLElement | null>(null);
  const [barHasRoom, setBarHasRoom] = useState(false);
  /* Read off the DETAIL rather than off `config`, because `config` is resolved
     below the early returns and this is a hook — hooks go above them all. */
  const framed = detail ? getKind(detail.kind).panel.composition === 'frame' : false;
  useEffect(() => {
    /*
     * ONLY THE ONE COMPOSITION THAT USES THE ANSWER, and only where the
     * platform can give one.
     *
     * The `framed` gate is not an optimisation — it is the blast radius. Every
     * kind renders this component, so an unconditional observer put a
     * ResizeObserver on nineteen panels to answer a question one of them asks.
     * MEASURED: jsdom does not implement ResizeObserver, and the unconditional
     * version threw `ReferenceError` out of 113 tests across 12 files that have
     * nothing to do with artifacts.
     *
     * The feature check is the same fact stated for the runtime: where there is
     * no observer, `barHasRoom` keeps its initial FALSE and the block draws its
     * controls in place. That is the arrangement that is always correct, just
     * not always the roomiest — the right way round for a fallback.
     */
    if (!framed || panelEl === null || typeof ResizeObserver === 'undefined') return;
    const measure = (width: number) => setBarHasRoom(width >= FRAME_CONTROLS_MIN_PANEL_PX);
    /* `clientWidth`, NOT a rect — the threshold is an unzoomed number and
       `.cv2-root`'s zoom would scale a rect out of that system. See the
       constant's docblock; this is the first-paint answer, before the observer's
       own callback arrives. */
    measure(panelEl.clientWidth);
    const ro = new ResizeObserver((entries) => {
      const entry = entries[0];
      if (entry) measure(entry.contentRect.width);
    });
    ro.observe(panelEl);
    return () => ro.disconnect();
  }, [framed, panelEl]);

  /**
   * D44 — which flow verb's config is expanded on the action bar, if any.
   *
   * ABOVE EVERY EARLY RETURN for the same reason `surfaceSlot` is: hooks do.
   *
   * `actionBarRef` is the DISMISSAL BOUNDS, and it has to contain both the
   * trigger and the card. The config dismisses on outside mousedown, so with
   * bounds covering only the card, Run's own mousedown would dismiss it a
   * moment before its click re-opened it — and the toggle could never close.
   */
  const [flowRef, setFlowRef] = useState<ActionRef | null>(null);
  const actionBarRef = useRef<HTMLDivElement>(null);

  /**
   * THE CONFIG BELONGS TO ONE ENTITY, AND ONLY `PanelStack` KEYS ITS PANELS.
   *
   * `EntityView`, `ChannelView` and `GraphScreen` each mount ONE panel and
   * change `selectedId` underneath it, so this component's state survives the
   * switch. The card dismisses on outside mousedown and on Escape; a BACK
   * PRESS fires neither. So it stayed open across the navigation and
   * `subject={detail}` silently re-pointed it at whatever entity arrived —
   * press Launch and you spawn against something the card never named. When
   * the new kind has no launch verb the trigger is gone too, leaving a config
   * nothing owns.
   *
   * Adjusted DURING RENDER rather than in an effect, deliberately: an effect
   * would paint one frame of the previous entity's config over the new
   * entity first, which is the same lie for 16ms. Keyed on IDENTITY alone —
   * anything broader (a counter tick, a streamed message) would slam the card
   * shut mid-edit, which is a worse bug than the one it fixes.
   *
   * "Identity" INCLUDES absence: `detail` going momentarily undefined for the
   * same entity — a cache refetch — also closes it. Stated because the rule
   * above reads narrower than the code, and this is the honest description.
   * Kept rather than special-cased: the config is a commitment surface, and
   * leaving one open over a loading skeleton is the same claim-without-a-
   * subject the reset exists to prevent.
   */
  const [flowSubjectId, setFlowSubjectId] = useState(detail?.id);
  if (detail?.id !== flowSubjectId) {
    setFlowSubjectId(detail?.id);
    if (flowRef !== null) setFlowRef(null);
  }
  const selectTab = (t: PanelTab) => {
    setUncontrolledTab(t);
    onTabChange?.(t);
  };

  /**
   * THE SAVE FLOW LIVES HERE, above every early return, because hooks do.
   *
   * `useTaskSave` tolerates a null detail by design (a panel legitimately
   * renders before its detail hydrates) and reports the reason through
   * `unavailable` instead of throwing, so the call is unconditional and the
   * loading panel below is unaffected.
   *
   * WHAT IT BUYS: `expectedVersion` is captured when the FIRST edit is made,
   * not re-read at save time. A write that lands while the user is typing
   * therefore produces a 409 the user can answer — reload or overwrite — where
   * the read-at-save-time version would have overwritten the other writer with
   * no conflict ever firing. The conflict is not an error path bolted on; it
   * is the designed consequence of holding the version the edit was based on.
   */
  const editableConfig = detail ? getKind(detail.kind) : null;
  const save = useTaskSave({
    detail: detail ?? null,
    commands: props.commands ?? null,
    onSaved: (result) => props.onSaved?.(result),
    onReload: (current) => props.onReloadDetail?.(current),
    editRefusal: editableConfig?.panel.capabilityReasons?.canEdit,
  });
  /** The refusal as ONE sentence. Three copies of this expression drifted the
      moment any one of them was reworded, so there is one. */
  const saveRefusal = refusalSentence(save);

  /**
   * PERMISSION-LOST SHORT-CIRCUITS EVERYTHING, and it must come first.
   * Rendering the normal chrome and swapping only the body would leak the
   * title, the kind and the counts — which is the exact failure mode. There is
   * no partial version of this state.
   */
  if (permissionLost) return <PermissionLostPanel onClose={onClose} />;

  if (!detail) {
    return (
      <div className={`pn-panel pn-panel--${host}`} data-testid="entity-detail-panel">
        <LoadingBody />
      </div>
    );
  }

  const config = getKind(detail.kind);
  const isTombstone = detail.deletedAt != null;

  /**
   * THE DARK-SHELL LAW (T0-1, in situ). The work_session panel is dark in its
   * ENTIRETY — crumb, header, action bar, tab strip, body and footer — not
   * just the strip and the canvas. Measured off T0-1's Z3 session markup:
   * every hairline is #2C2719, the title is #EFE9DB, the controls are #8C8470
   * hovering to #302A1D, and the exited fallback sits on #1B1810 rather than
   * paper.
   *
   * WHY IT WAS WRONG BEFORE, recorded because the provenance matters: D24
   * ruled that panel chrome follows the theme and only the strip and host stay
   * dark, citing T0-2's #exited frame, which draws a LIGHT exited session
   * panel. That is a standalone COMPONENT frame; the COMPOSED canvas draws the
   * same state dark. Generalising from the component canvas to the composed
   * one is exactly the error D38 names — made before D38 was written, and not
   * caught when it was.
   *
   * The mechanism is unchanged (D16/D24): a nested `.cv2-root[data-theme=
   * "dark"]` scope re-declares the real dark tokens through tokens.css's own
   * selector. Only the BOUNDARY moves — from strip+host to the whole panel —
   * so there is still zero duplicated hex and it still cannot drift.
   *
   * Keyed on the ARCHETYPE, a registry field: no kind literal (§15.2).
   */
  const isTerminal = config.panel.archetype === 'terminal';
  const alwaysDark = isTerminal;

  /**
   * THE BODY ENDS THE PANEL — the three trailing regions are off.
   *
   * ONE PREDICATE for the attachment strip, the attention section and the
   * footer, because they are one decision: does anything belong between this
   * body and the panel's bottom edge? The terminal archetype has always
   * answered no through its own arm; `composition` is how a kind answers no
   * WITHOUT being a terminal, and it is read as PRESENCE rather than value by
   * design — a third composition arriving must not silently inherit a footer
   * nobody chose for it. Today: `chat` (a conversation ends at its composer)
   * and `frame` (an artifact viewport takes the pixels).
   */
  const bodyOwnsBottom = isTerminal || config.panel.composition != null;

  /**
   * THE CONTROLS RIDE THE PANEL BAR — the same slot, for the second reason.
   *
   * `pn-panelbar__surface` was opened for the work session's five surface
   * chips; `composition: 'frame'` is the other kind of body that has controls
   * belonging to a viewport rather than to a row above it. The slot is
   * `display: contents`, so an unused one costs no box, and the body portals
   * into it only if it is there (see `WorkSessionContent`'s `switchSlot`, the
   * pattern this follows) — a mount that renders no slot still gets its
   * controls, in place, rather than losing them.
   */
  const controlsRideBar = isTerminal || config.panel.composition === 'frame';

  /**
   * WHAT THE MERGE CONFIRM WOULD NAME — `repo#n`, or null when this row does
   * not read as a pull request at all.
   *
   * Read through `pullRequestFactsOf`, which decides from the row's own SHAPE
   * and answers null for everything else. That is what keeps the merge flow
   * out of this file's knowledge of kinds (§15.2): the panel never asks what
   * the entity is, only whether a PR reader could make sense of it.
   */
  const mergeSubject = pullRequestFactsOf(detail);
  /** A const, so the guard below narrows inside the commit callback too. */
  const mergePr = props.mergePr;

  /**
   * THE CONTROL STRIP — ONE ROW, UNDER THE TABS.
   *
   * USER RULING 2026-08-05, on the task panel, verbatim: "the top part is
   * showing the drop downs in vertical, they should be in a single row … below
   * the tabs (task, discussion, connections, activity) a row with these drop
   * downs." (That ruling named the tab row as it stood then; the row is now
   * task · connections · discussion, and the strip's place under it is
   * unchanged.)
   *
   * Two things were wrong and they are separate:
   *
   *  1. THE LAYOUT. The panel mounted the strip in its DEFAULT `lines`
   *     variant — `.lp__rowdetail` is `flex-direction: column`, one labelled
   *     line per control — so four controls became four stacked rows filling
   *     the top of the panel. `chips` is the layout the same strip already
   *     uses in the control-card, where the control IS the chip: one row,
   *     labels as accessible names, archive pushed to the far end.
   *
   *  2. THE PLACE. It sat between the title and the tabs. Below the tabs it
   *     reads as what it is — the axes of the thing the tabs are about — and
   *     it is still reachable from every tab, which is why it is rendered
   *     here rather than gated on the Content tab.
   *
   * NO ARCHETYPE KEEPS THE OLD POSITION, and the SESSION now keeps no band at
   * all — USER RULING 2026-08-06, on the bar above the terminal: remove it.
   *
   * The history is worth one paragraph because it is two rulings deep. A first
   * pass left the terminal archetype in the stacked `lines` variant ABOVE the
   * tabs, reasoning that a terminal owns its full height below them (user
   * ruling 2026-07-31, "terminal all the way, till the component bottom"). A
   * second ruling (2026-08-05) moved it into the chip band with everything
   * else, which was cheaper — ~34px instead of ~90px — but still spent the row
   * on two things a session cannot do: its state is observed, not chosen, and
   * archive is not the verb anyone opens a live terminal to reach.
   *
   * So the band is gone for the session, and it is `controlsFor` above that
   * removes it — on the registry's own `readOnlyReason`, not on `isTerminal`.
   * There is still no archetype literal in this decision, which is what keeps
   * a seventh archetype from arriving and having to remember it.
   *
   * NOT ON A TOMBSTONE. A deleted entity cannot be edited (the server refuses,
   * and `useTaskSave` already says "restore it before editing"), and its ONE
   * live verb is restore — which `TombstoneBody` owns below. Rendering the
   * strip here too would put two restore controls in one panel, which is the
   * duplication D67 removed from the tile.
   *
   * AND NOT WHERE NOTHING IS WIRED — USER RULING 2026-08-18. `controlsFor` asks
   * the REGISTRY what this kind has; `stripHasLiveControl` asks THIS HOST what
   * it can actually perform, and the band needs both. Two mounts below pass no
   * `controls` prop at all (`ChannelView`, `GraphScreen`), so every control in
   * the fallback host rendered not-wired and the band spent 37px on four
   * refusals. The gate only ever NARROWS: a band that renders today renders
   * only where at least one of its controls can be used.
   */
  const controlHost = props.controls ?? { kind: detail.kind, ctx: props.ctx };
  const strip =
    controlsFor(config) && stripHasLiveControl(controlHost, config) && !isTombstone ? (
      <EntityControlStrip
        row={subjectOf(detail)}
        props={controlHost}
        config={config}
        variant="chips"
      />
    ) : null;

  return (
    <section
      /*
       * The dark scope is applied to the PANEL ITSELF, not by wrapping it.
       *
       * d806c90 wrapped this section in <AlwaysDark>, which is a
       * `display: contents` element — no box, so no layout impact, which is
       * why it looked free. It is not free: `display: contents` removes the
       * element from the BOX tree but NOT from the DOM, so a direct-child
       * selector stops matching. The shell's `.shell-stack__col > *`
       * flex-grow rule then applied to the wrapper (which generates no box
       * and cannot grow) instead of the panel, and session panels alone took
       * their content width and left the stage empty. That is R5 #7's
       * re-opening, and it was mine.
       *
       * `.cv2-root[data-theme="dark"]` is tokens.css's own selector, so
       * putting both on this element opens exactly the same token scope with
       * one fewer node and no relationship for a sibling's CSS to lose.
       */
      className={`${alwaysDark ? 'cv2-root ' : ''}pn-panel pn-panel--${host}${isTombstone ? ' pn-panel--tombstone' : ''}`}
      data-theme={alwaysDark ? 'dark' : undefined}
      data-always-dark={alwaysDark ? 'true' : undefined}
      /* Measured by `barHasRoom` above — a frame body's controls only ride the
         bar where the tabs are not the ones paying for them. */
      ref={setPanelEl}
      data-testid="entity-detail-panel"
      data-host={host}
      data-archetype={config.panel.archetype}
      /* A structural styling/a11y seam for the active surface. It states the
         selected panel tab without teaching CSS a kind literal. */
      data-panel-tab={tab}
      /* THE PANEL IS THE FALLBACK DROP TARGET (2026-08-18). With the empty ＋
         tile gone, drop is the attach path — and the only body that had marked
         itself a drophost was `subtree`, so every other kind would have had no
         path at all. Marking the panel gives all of them one; a body with a
         better-placed target (the task description block) still wins, because
         the strip binds to its CLOSEST marked ancestor, not to this one. The
         listeners only exist where the strip mounts, so terminal and chat
         panels — which never mount it — stay inert. */
      data-attachment-drophost=""
      /* A labelled region: panels are landmarks, and a screen-reader user
         moving between three pinned columns needs them named. */
      aria-label={`${config.label}: ${detail.title}`}
    >
      <PanelHeader
        detail={detail}
        config={config}
        breadcrumb={breadcrumb}
        liveness={props.liveness}
        /* THE TITLE is editable only where registry data and the seam both
           permit it. The visual treatment stays plain by user direction; the
           actual click/keyboard editor is still mounted only when writable. */
        titleEditable={(config.list.inlineEdit?.title ?? false) && save.unavailable === null}
        titleLockReason={config.list.inlineEdit?.title ? saveRefusal : undefined}
        autoFocusTitle={props.justCreated}
        supplemental={
          (props.linkedPullRequests?.length ?? 0) > 0 ? (
            <LinkedPullRequestChips
              pullRequests={props.linkedPullRequests ?? []}
              placement="detail"
            />
          ) : undefined
        }
        onCommitTitle={(title) => void save.commitNow({ title })}
      />

      {stalePin ? (
        <StalePinBanner pinnedVersion={stalePin.pinnedVersion} liveVersion={stalePin.liveVersion} />
      ) : null}

      <TabStrip
        active={tab}
        contentLabel={config.label}
        counts={{
          discussion: props.messages?.length,
          connections: countConnections(detail, props.connections),
        }}
        end={
          /*
           * THE PHONE'S END CLUSTER IS THE SAVE AFFORDANCE AND TRANSFER, and
           * everything else in it has moved into the floating action menu —
           * user ruling 2026-08-20. `TabStrip` renders no strip at all on this
           * shell (see its `oneSurface` branch), so what is passed here is the
           * whole of the region.
           *
           * SAVECONTROLS STAY INLINE, DELIBERATELY. A pending unsaved title
           * edit hidden inside a closed menu is a data-loss shape, not a layout
           * choice: the user cannot see that there is something to save, and
           * the two verbs that answer it are two taps away behind a control
           * that gives no sign it is holding them.
           *
           * TRANSFER STAYS INLINE TOO, and it is the ONE verb that could not
           * follow the others. `TransferControl` renders NOTHING unless a
           * remote server is registered and the kind is transferable — its
           * docblock argues at length that this is the deliberate exception to
           * disabled-with-reason, because on a single-server node "transfer to
           * another server" is not a deferred feature but a concept that does
           * not apply. A menu row obeys the opposite rule: present, dimmed,
           * carrying its reason. Moving it would either overrule that decision
           * or force this file to re-implement an async, kind-aware gate that
           * `src/transfer` owns (§15.2). It self-gates to null, so where it
           * does not apply the row collapses with it.
           *
           * BOTH ARMS OMIT THE SURFACE SLOT. `WorkSessionContent` declines the
           * slot on a phone anyway (`ridesPanelBar`), so passing one here has
           * had no effect on this shell since `099c3a03`; not passing it is the
           * same fact said in the direction that cannot rot.
           */
          oneSurface ? (
            <>
              {config.list.inlineEdit?.title || config.list.inlineEdit?.status ? (
                <SaveControls save={save} />
              ) : null}
              <TransferControl detail={detail} />
            </>
          ) : (
          <>
            {controlsRideBar ? (
              <div
                className="pn-panelbar__surface"
                ref={setSurfaceSlot}
                data-testid="panel-surface-slot"
              />
            ) : null}
            <ActionBar
              barRef={actionBarRef}
              config={config}
              /* The terminal archetype is the only bar that ALSO carries the
                 five surface chips, so it is the only one whose primaries have
                 to give up their words. Registry data, never a kind literal. */
              markPrimaries={isTerminal}
              /* Filled from the detail — see `panelActionContext`, which is
                 also what the phone's action menu asks, so the bar and the menu
                 cannot form different opinions about the same verb. */
              ctx={panelActionContext(detail, ctx, props.liveness)}
              onAction={props.onAction}
              wiredActions={props.wiredActions}
              openFlow={flowRef}
              /* Only when the host actually has launch sources. Without them
                 the expand would render an empty teammate select over an
                 un-committable Launch — a config that cannot configure is a
                 worse answer than the honest "not wired here" refusal. */
              /* Wired when the host can serve AT LEAST ONE flow. Without any,
                 the expand would open an empty card — and a config that cannot
                 configure is a worse answer than the honest "not wired here"
                 refusal. Which surface opens is decided below, by the verb. */
              onFlow={props.launch || mergePr ? setFlowRef : undefined}
              /*
               * DEF-004 — RUN OPENS THE FULL SHEET WHERE THE HOST MOUNTS ONE.
               *
               * The list row has had this precedence since D44 ("the sheet
               * OUTRANKS the inline expand"); the detail panel did not, so the
               * SAME VERB on the SAME ENTITY behaved differently depending on
               * which surface you pressed it from.
               *
               * It matters most on a phone, and that is why it arrives now. The
               * inline expand is `.pn-actions__flow` — absolute, 300px wide,
               * anchored to a 30px bar — and CONTRACT.md §4 rules that anchored
               * popovers "do not survive the trip to a 390px header". The full
               * sheet now HAS a phone arrangement; the quick config does not.
               * On a phone the detail panel is also the surface where Run is
               * reliably reachable at all: the list row's cluster is
               * hover-revealed.
               *
               * Spread, never defaulted: absent leaves the expand exactly as it
               * was for every host without a sheet.
               *
               * GATED ON `oneSurface`, AND THAT IS A SCOPE DECISION RATHER THAN
               * A TECHNICAL ONE — stated because the unconditional version is
               * arguably the better product and I am deliberately not shipping
               * it here. Applying this precedence everywhere would make the
               * desktop detail panel agree with the desktop LIST ROW, which has
               * had the rule since D44; today they disagree, and that
               * inconsistency is real. But it is a DESKTOP behaviour change, in
               * a shell that is in daily use, with no row behind it, no
               * evidence, and nobody having asked — in a program scoped to
               * coarse-pointer phones. Widening it is a separate decision for
               * whoever owns the desktop; it is filed as an observation, not
               * smuggled in under a phone fix.
               */
              {...(oneSurface && props.launch?.onFullOptions
                ? { onOpenLaunch: props.launch.onFullOptions, launchSubjectId: detail.id }
                : {})}
              flowSurface={
                flowRef && resolveAction(flowRef).flow === 'merge-pr' && mergePr && mergeSubject ? (
                  <MergePullRequestFlow
                    key={flowRef}
                    pr={mergeSubject}
                    headSha={mergePr.headShaFor?.(detail.id) ?? null}
                    githubLogin={mergePr.githubLogin ?? null}
                    onMerge={(input) => mergePr.onMerge(detail.id, input)}
                    onDismiss={() => setFlowRef(null)}
                    boundsRef={actionBarRef}
                  />
                ) : flowRef && resolveAction(flowRef).flow === 'launch' && props.launch ? (
                  <LaunchQuickConfig
                    subject={detail}
                    /* The mode is the VERB's, read off the registry — so
                       Coordinate commits a coordinator and not Run's worker,
                       and no component here has to name either verb. */
                    /* THE CARD BELONGS TO ONE VERB, SO THE VERB IS ITS IDENTITY.
                       `mode` and `verbLabel` are props, but the config is STATE
                       seeded once. Without this key, pressing Coordinate then
                       Run reused the instance: the heading re-rendered to "Run
                       configuration" over a config still holding
                       mode:'coordinator', and Launch spawned a coordinator
                       under a button labelled Run. The dismissal cannot save it
                       either — the other verb's button is inside the same
                       `actionBarRef` bounds as the card. Remounting also clears
                       the refusal, pending and access-mode state, all of which
                       are equally stale across a verb switch. */
                    key={flowRef}
                    verbLabel={resolveAction(flowRef).label}
                    {...(resolveAction(flowRef).launchMode
                      ? { mode: resolveAction(flowRef).launchMode }
                      : {})}
                    spaceId={props.launch.spaceId || ctx.spaceId}
                    teammates={props.launch.teammates}
                    projects={props.launch.projects}
                    loadFor={props.launch.loadFor}
                    capacity={props.launch.capacity}
                    profileFor={props.launch.profileFor}
                    onSpawn={props.launch.onSpawn}
                    onFullOptions={
                      props.launch.onFullOptions
                        ? () => {
                            props.launch?.onFullOptions?.(detail.id);
                            setFlowRef(null);
                          }
                        : undefined
                    }
                    onDismiss={() => setFlowRef(null)}
                    boundsRef={actionBarRef}
                    newClientMutationId={() =>
                      props.launch?.mutationId(detail.id) ?? newLaunchMutationId()
                    }
                  />
                ) : null
              }
            />
            {config.list.inlineEdit?.title || config.list.inlineEdit?.status ? (
              <SaveControls save={save} />
            ) : null}
            {/* Cross-server transfer (user ruling 2026-08-18: panel, not tile).
                Self-gating: renders nothing unless a remote server connection
                is registered, so the single-server case never sees it. Kind
                awareness lives in src/transfer, not here (§15.2). */}
            <TransferControl detail={detail} />
            <PanelWindowControls
              onPromote={props.onPromote}
              onClose={onClose}
              /* Same crowding, same gate: the surface-chip bar gives up ⤢ on a
                 desktop. The control itself refuses this on a phone, where ✕
                 is already gone — see `promoteHidden`. */
              promoteHidden={isTerminal}
              /* THE PIN, FINALLY RENDERED. These three props were declared on
                 this panel and passed by WorkspaceView from the day the pin
                 engine shipped, and NOTHING ever drew them — the anatomy
                 census's one wholly dead prop set. The control lives with the
                 other window verbs because pinning is a window fact (which
                 column this panel occupies), not an entity verb. */
              pinned={props.pinned}
              pinRefusal={props.pinRefusal}
              onPin={props.onPin}
            />
          </>
          )
        }
        onSelect={selectTab}
      />

      {/* The band is gated on the strip alone: a kind with no controls (a doc
          declares none) would otherwise draw an empty padded row with a
          hairline under the tabs. No archetype gate — see `strip` above. */}
      {strip ? (
        <div className="pn-controls" data-testid="panel-controls">
          {/* The BAND is full-bleed; its contents ride the reading measure.
              Subtree detail names the dense authoring row once, then keeps
              every native control in one horizontally reachable group. The
              strip remains the measure's first ELEMENT: panel-controls pins
              that DOM contract because layout consumers measure it directly.
              The visible eyebrow is generated by task-detail.css, while this
              accessible name supplies the same label without an extra node. */}
          <div
            className="pn-controls__measure"
            role={config.panel.archetype === 'subtree' ? 'group' : undefined}
            aria-label={config.panel.archetype === 'subtree' ? 'Controls' : undefined}
          >
            {strip}
          </div>
        </div>
      ) : null}

      {/* The error boundary wraps the BODY only: header, tabs and footer stay
          live so close, expand and Esc keep working through a failed render.
          TWO layers, honestly distinct: the `error` PROP is the caller
          reporting a data failure; CatchBoundary is the REAL
          componentDidCatch for a body that throws while rendering — until
          it existed, "never white-screens" was a comment, not a mechanism
          (Surface Audit). */}
      {error ? (
        <ErrorBody errorText={error} onRetry={props.onRetry} />
      ) : loading ? (
        <LoadingBody />
      ) : (
        <CatchBoundary label={`${config.label.toLowerCase()} body`}>
          {/* THE CONFLICT AND REFUSAL CARDS RIDE IN THE BODY, never the
              header — a card carrying a cause, an aftermath and two real
              moves cannot live in a 30px row. `AuthoringHost` renders nothing
              at all while the save is clean, so this costs the body no height
              in the ordinary case. */}
          <AuthoringHost save={save}>
            {/*
              ATTACHMENTS RIDE IN THE CONTENT BODY — not in a fifth tab. D3
              fixes the panel at four tabs for every kind (user ruling
              2026-08-01), and the content body is the one region allowed to
              vary. The element is BUILT here rather than inside each
              archetype arm so it is genuinely kind-agnostic: one construction
              serves task, doc, work_session and every custom kind, and no
              future archetype can forget to include it.

              THREE EXCLUSIONS, all structural, none a kind check, and two of
              them now ride ONE predicate (`bodyOwnsBottom`, above): a tombstone
              shows only its tombstone, and every other exclusion is the same
              question — does anything belong between this body and the panel's
              bottom edge? The terminal archetype answers no (a live PTY canvas
              with a strip stapled under it is not a design, it is a leak), and
              so does any declared `composition`: 'chat' ends at its composer,
              where the ＋ already owns attach, and 'frame' is a viewport the
              panel exists to fill.

              PLACEMENT is the body's (2026-08-16 addendum): the subtree
              archetype consumes the slot inside its description block; every
              other archetype keeps today's placement, after the body. One
              structural boolean, beside the three exclusions above.
            */}
            {(() => {
              const attachmentSlot =
                tab === 'content' && !isTombstone && !bodyOwnsBottom ? (
                  <AttachmentStrip
                    anchorId={detail.id}
                    files={attachedFiles(detail)}
                    downloadHref={props.attachments?.downloadHref}
                    startUpload={props.attachments?.startUpload}
                    projectFolder={props.attachments?.projectFolder}
                    onUploaded={props.onAttachmentUploaded}
                    onDetach={props.attachments?.detach}
                    /* A detach and an upload change the SAME thing — the
                       anchor's `attached_to` edges — so they share one
                       refetch, and a host cannot wire adding without also
                       wiring removing. */
                    onDetached={props.onAttachmentUploaded}
                  />
                ) : null;
              const bodyConsumesSlot = config.panel.archetype === 'subtree';
              /* ATTENTION HISTORY rides on the SAME three exclusions as the
                 strip — and unlike the strip, the two archetypes it excludes do
                 not LOSE the section: `PanelBody`'s connections arm mounts it
                 for them instead. Ordered above the strip because an escalation
                 someone may still be waiting on outranks a file list. It never
                 goes into the subtree body's slot: that slot is the description
                 block's, and a scored queue is not a description. */
              const attentionSlot =
                tab === 'content' && !isTombstone && !bodyOwnsBottom
                  ? props.attentionSection
                  : null;
              return (
                <>
                  <PanelBody
                    {...props}
                    detail={detail}
                    tab={tab}
                    save={save}
                    surfaceSlot={surfaceSlot}
                    barSlot={barHasRoom ? surfaceSlot : null}
                    attachmentSlot={bodyConsumesSlot ? attachmentSlot : null}
                  />
                  {attentionSlot}
                  {bodyConsumesSlot ? null : attachmentSlot}
                </>
              );
            })()}
          </AuthoringHost>
        </CatchBoundary>
      )}

      {/* USER RULING 2026-07-31 — "terminal all the way, till the component
          bottom." The footer is the last strip between the canvas and the
          panel edge, so terminal panels do without it. It stays for every
          other archetype: the reading it carries (presence · author · version)
          is honest chrome for a document, and only the terminal has a primary
          surface whose whole value is the pixels this row was taking.
          A declared `composition` joins the exclusion for the same structural
          reason: a conversation ends at its composer and an artifact frame ends
          at the panel edge, not at a chrome strip below either. */}
      {bodyOwnsBottom ? null : (
        <PanelFooter
          detail={detail}
          presenceHollowReason={reasons.presenceHollow}
          versionHistoryReason={reasons.versionHistory}
        />
      )}
    </section>
  );

}

/**
 * The save refusal rendered as ONE sentence, in the cause—remedy voice every
 * `toReason()` consumer splits back apart. It reads the same in the title
 * lock, the description editor and the acceptance boxes because there is one
 * expression rather than three copies of it.
 */
function refusalSentence(save: TaskSaveHandle): string | undefined {
  return save.unavailable
    ? `${save.unavailable.cause} — ${save.unavailable.remedy}`
    : undefined;
}

function PanelBody(
  props: EntityDetailPanelProps & {
    detail: EntityDetail;
    tab: PanelTab;
    save: TaskSaveHandle;
    /** The panel bar's slot node for the terminal/chat switch. Null elsewhere. */
    surfaceSlot?: HTMLElement | null;
    /** The SAME node, offered to a `composition: 'frame'` body only when the bar
        has room for its controls — see `barHasRoom`. Null ⇒ draw them in place. */
    barSlot?: HTMLElement | null;
    /** The attachment tiles, built by the panel; the subtree body places them
        inside its description block. Null for every other archetype. */
    attachmentSlot?: ReactNode;
  },
) {
  const { detail, tab, reasons, onOpenEntity, save } = props;
  const config = getKind(detail.kind);
  const saveRefusal = refusalSentence(save);
  const startUpload = props.attachments?.startUpload;

  if (tab === 'discussion') {
    /*
     * ONE CONVERSATION SURFACE, host-composed. The tab's own renderer and
     * composer are gone: they read `messages.list` (the `anchored` predicate
     * alone) and did not page, which made the always-visible reading a strict
     * subset of the one behind the Chat chip.
     *
     * NO FALLBACK RENDERER. A host that forgets this prop gets the same honest
     * alert every other seam-backed surface uses, and `panel-host-wiring.test.ts`
     * fails the build before it can ship. A second renderer kept "just in case"
     * is how the two readings diverged in the first place.
     */
    const surface = props.discussionSurface ?? (
      <p className="pn-surface-host-missing" role="alert">
        This entity&rsquo;s Discussion surface is unavailable in this view.
      </p>
    );

    /* The subtree archetype gets a real tabpanel frame around the shared feed:
       the masthead names messages and activity as one timeline, while the
       ChannelScreen below keeps ownership of paging, composer and honesty
       states. Other archetypes retain their established composition. */
    if (config.panel.archetype === 'subtree') {
      return (
        <div
          className="pn-task-discussion k-enter"
          id="tabpanel-discussion"
          role="tabpanel"
          aria-labelledby="tab-discussion"
          data-testid="task-discussion"
        >
          <div className="pn-task-discussion__masthead k-hero">
            <div className="pn-task-discussion__heading">
              <span className="k-label">Discussion</span>
              <strong>Decisions, updates, and activity</strong>
            </div>
            <span className="pn-task-discussion__context">Shared timeline</span>
          </div>
          <div className="pn-task-discussion__surface">{surface}</div>
        </div>
      );
    }

    return surface;
  }
  if (tab === 'connections') {
    /**
     * THE ATTENTION SECTION'S OVERFLOW HOME, for the bodies that cannot take
     * it inline — terminal (a live PTY owning its full height) and any declared
     * `composition` (a chat that ends at its composer, an artifact frame that
     * fills the panel). Those are excluded from the content-body mount for the
     * same structural reasons the attachment strip excludes them, and a work
     * session is one of the most-escalated things in a space, so dropping the
     * section for them would have made session attention history reachable only
     * from the CLI (user ruling 2026-08-16).
     *
     * IT MOVED HERE FROM THE ACTIVITY TAB when that tab was removed
     * (2026-08-19). Connections is where it belongs of the two remaining: an
     * escalation is a fact ABOUT this entity's standing, like its edges, where
     * Discussion is a conversation with its own composer and paging and would
     * have had to grow a slot to take it.
     *
     * The CONDITION IS THE EXACT COMPLEMENT of the content-body one, so the
     * section renders in exactly one place per kind and can never appear twice
     * — `panels.test.tsx` asserts both halves of that.
     *
     * Deliberately ABOVE the tab: it is the shorter, more actionable half, and
     * the peer list has no natural end to append below.
     */
    const overflow =
      config.panel.archetype === 'terminal' || config.panel.composition != null;
    return (
      <>
        {overflow ? props.attentionSection : null}
        <ConnectionsTab
          detail={detail}
          connections={props.connections}
          onOpenEntity={onOpenEntity}
          /* The SAME surface the session's Graph chip renders, offered here for
             every kind — see the tab's docblock. (The old comment here claimed
             "sessions never reach this arm"; they do, and always did — this
             body has no early return for the terminal archetype, and every host
             passes `graphSurface` unconditionally. So a session has two
             entrances to one canvas. Left as-is: it is pre-existing and closing
             it is a ruling about the session chip row, not about tab order.) */
          graph={props.graphSurface}
        />
      </>
    );
  }

  // Content. A deleted entity keeps its chrome and its place; only the body
  // becomes the tombstone, because references to it must stay resolvable.
  if (detail.deletedAt) {
    return (
      <TombstoneBody
        deletedBy={detail.createdBy}
        canRestore={detail.capabilities.canDelete}
        onRestore={props.onRestore}
        restoreUnavailableReason={
          detail.capabilities.canDelete && !props.onRestore
            ? 'restoring is not wired on this surface'
            : undefined
        }
      />
    );
  }

  /**
   * THE ONLY PER-KIND SWITCH IN THE PANEL — and it is on ARCHETYPE, a
   * registry field, not on kind. Fifteen kinds, six archetypes, one switch.
   */
  if (config.panel.archetype === 'terminal') {
    const interactionProfile = (
      detail.content as unknown as {
        interactionProfile?: WorkSessionInteractionProfileProjection | null;
      }
    ).interactionProfile ?? null;
    return (
      <WorkSessionContent
        sessionId={detail.id}
        viewerMemberId={props.viewerMemberId}
        profile={interactionProfile}
        requestedSurface={props.contentSurface}
        onSurfaceChange={props.onContentSurfaceChange}
        switchSlot={props.surfaceSlot}
        terminal={
          /*
           * THE "transcript ↗" CHIP BECOMES REAL HERE.
           *
           * `TerminalBody` has drawn that chip on every exited session since it
           * was written, and no host ever supplied `onOpenTranscript` — an
           * ENABLED button with `onClick={undefined}`, which is exactly the
           * enabled-inert control this panel's honesty rules ban everywhere
           * else. It could not be supplied before now: there was no transcript
           * surface to open, and an exited session's own words were reachable
           * only by digging through the Debug journal.
           *
           * Opening it is just selecting the surface. The host already
           * round-trips that choice back as `requestedSurface` — the same path,
           * in the other direction, as the conversation surface's own way back
           * to the terminal.
           */
          <TerminalBody
            detail={detail}
            serverBaseUrl={props.serverBaseUrl}
            liveness={props.liveness ?? 'unknown'}
            streaming={props.streaming}
            needsAttention={props.needsAttention}
            attentionDetail={props.attentionDetail}
            /* `handoffs`, the two share reasons and `onOpenEntity` are no
               longer passed: `TerminalBody` stopped accepting them when the
               session-details drawer was removed (user ruling 2026-08-19).
               They are still read here for the rest of the panel. */
            livenessLabel={config.list.liveTreatment?.(props.liveness ?? 'unknown').label}
            livenessReason={config.list.liveTreatment?.(props.liveness ?? 'unknown').reason}
            {...(props.sessionStatsSurface
              ? { statsSurface: props.sessionStatsSurface }
              : {})}
            {...(props.onContentSurfaceChange
              ? { onOpenTranscript: () => props.onContentSurfaceChange?.('transcript') }
              : {})}
            {...(props.onResumeSession ? { onResume: props.onResumeSession } : {})}
            {...(props.resumingSession ? { resuming: props.resumingSession } : {})}
            {...(props.onMarkSessionExited
              ? { onMarkExited: props.onMarkSessionExited }
              : {})}
          />
        }
        transcript={props.conversationSurface ?? (
          /* Surface-generic on purpose: the slot is composed by the host and
             its occupant is a registry decision, so this copy must stay true
             whichever surface a host forgot to wire. */
          <p className="pn-surface-host-missing" role="alert">
            This session&rsquo;s conversation surface is unavailable in this view.
          </p>
        )}
        debug={props.debugSurface ?? (
          <p className="pn-surface-host-missing" role="alert">
            The debug journal host is unavailable in this view.
          </p>
        )}
        git={props.gitSurface ?? (
          <p className="pn-surface-host-missing" role="alert">
            The session git host is unavailable in this view.
          </p>
        )}
        graph={props.graphSurface ?? (
          <p className="pn-surface-host-missing" role="alert">
            The session graph host is unavailable in this view.
          </p>
        )}
      />
    );
  }

  /* The four remaining archetype arms (Surface Audit 2026-07-29: five
     finished bodies had ZERO importers — the switch was the unowned edit).
     Same law as the terminal arm: ARCHETYPE, a registry field, never kind. */
  if (config.panel.archetype === 'subtree') {
    return (
      <SubtreeBody
        detail={detail}
        blocks={config.panel.blocks}
        livenessOf={props.livenessOf}
        onOpenEntity={onOpenEntity}
        memoryAuthoring={props.memoryAuthoring}
        membershipAuthoring={props.membershipAuthoring}
        descriptionDraft={typeof save.edits.description === 'string' ? save.edits.description : undefined}
        onDescriptionChange={
          save.unavailable ? undefined : (description) => save.edit({ description })
        }
        descriptionUnavailableReason={saveRefusal}
        criteriaDraft={save.edits.acceptanceCriteria}
        onCriteriaChange={
          save.unavailable
            ? undefined
            : (acceptanceCriteria) => save.edit({ acceptanceCriteria })
        }
        criteriaUnavailableReason={saveRefusal}
        gitSection={config.panel.gitSection ? props.taskGitSection : undefined}
        skillOptions={props.skillOptions}
        /* Same binding as the Discussion composer and the doc editor: the
           anchor is this entity, so a file inserted into the description is
           also a listed attachment on the same record. */
        attach={startUpload ? (file: File) => startUpload(file, detail.id) : undefined}
        onAttached={props.onAttachmentUploaded}
        attachmentSlot={props.attachmentSlot}
      />
    );
  }
  if (config.panel.archetype === 'reader') {
    /* T5-3 MOUNT: the reader archetype is read AND write. `ReaderSurface`
       holds the doc save handle (a hook, so it cannot live in this switch) and
       renders ReaderBody or DocEditor depending on stance. Absent `commands`
       ⇒ Edit is disabled-with-reason, which is the pre-mount behaviour
       preserved rather than a new dead control. */
    return (
      <ReaderSurface
        detail={detail}
        blocks={config.panel.blocks ?? []}
        historyUnavailableReason={reasons.versionHistory}
        onOpenEntity={onOpenEntity}
        commands={props.commands ?? null}
        onSaved={props.onSaved}
        onReloadDetail={props.onReloadDetail}
        /* THE SAME RESOLVER THE STRIP USES, and deliberately the same one: a
           file the strip can download is a file the document can show inline.
           Absent host port ⇒ absent here ⇒ `Markdown` states each internal
           image rather than guessing a transport path. */
        fileHref={props.attachments?.downloadHref}
        /* The anchor is bound HERE so `doc-edit/` never learns which entity it
           is uploading against — and it is the document's own id, so an
           inserted image is also a listed attachment on the same record. */
        attach={
          startUpload ? (file: File) => startUpload(file, detail.id) : undefined
        }
        onAttached={props.onAttachmentUploaded}
        /* `DocEditor`/`DocSplitView` have threaded `skillOptions` since the
           lift; this is the panel host finally supplying the data. Absent ⇒
           `/` types plain text in the source, which is what it did before. */
        skillOptions={props.skillOptions}
      />
    );
  }
  if (config.panel.archetype === 'hub') {
    /*
     * THE HUB'S REDIRECT CAME HOME (user ruling 2026-08-01).
     *
     * HubBody's thesis was "content is the front door, never the feed", and it
     * ended with a note pointing at the surface that DID render the feed. That
     * surface was the rail's channel screen. Channels now live in the Entity
     * List Panel and open HERE, so the note would point at nothing and the
     * front door would be the only room in the house.
     *
     * So when the host supplies a feed, the hub renders its front-door regions
     * AND the live feed beneath them. When it does not, HubBody is unchanged —
     * a hub kind with no feed host still gets exactly what it always got.
     * `conversationSurface` is the same prop the terminal arm consumes: one host slot
     * for "the live conversation for this entity", not a second channel-shaped
     * one.
     */
    return (
      <>
        <HubBody
          detail={detail}
          blocks={config.panel.blocks ?? []}
          messages={props.messages}
          hasFeed={props.conversationSurface != null}
          onOpenEntity={onOpenEntity}
        />
        {props.conversationSurface ? (
          <div className="pn-hub-feed">{props.conversationSurface}</div>
        ) : (
          /* The terminal arm's honesty, extended here: a hub without a feed
             host used to render NOTHING below the front door — a channel you
             could neither read nor post to, with no sign anything was missing.
             All hosts now wire the slot via `conversationSurfaceFor`, so this alert is
             the tripwire for the next host that forgets. */
          <p className="pn-surface-host-missing" role="alert">
            This channel&rsquo;s conversation surface is unavailable in this view.
          </p>
        )}
      </>
    );
  }
  if (config.panel.archetype === 'profile') {
    return (
      <ProfileBody
        detail={detail}
        blocks={config.panel.blocks ?? []}
        livenessOf={props.livenessOf}
        onOpenEntity={onOpenEntity}
        memoryAuthoring={props.memoryAuthoring}
        onMarkMemory={props.onMarkMemory}
      />
    );
  }

  if (config.panel.archetype === 'governed') {
    return (
      <GovernedBody
        detail={detail}
        blocks={config.panel.blocks ?? []}
        livenessOf={props.livenessOf}
        onOpenEntity={onOpenEntity}
      />
    );
  }
  if (config.panel.archetype === 'restricted') {
    return (
      <RestrictedBody
        detail={detail}
        blocks={config.panel.blocks ?? []}
        onOpenEntity={onOpenEntity}
      />
    );
  }

  return (
    <GenericBody
      detail={detail}
      blocks={config.panel.blocks ?? DEFAULT_BLOCKS}
      onOpenEntity={onOpenEntity}
      /* The panel bar's end slot, for a block whose controls belong to the bar
         rather than to a row above itself — `composition: 'frame'`. Null for
         every other kind AND for a panel too narrow to seat them (`barHasRoom`),
         and a block that gets null renders its controls in place — so this is an
         ARRANGEMENT and never a requirement. */
      barSlot={props.barSlot}
      commands={props.commands}
      onSaved={props.onSaved}
      downloadHref={props.attachments?.downloadHref}
      membership={props.membershipAuthoring}
      /* The membership block's member TILES (user ruling 2026-08-13): a
         collection's items draw the kind's own list tile, so they need a
         list-shaped host. `ControlHost` is a STRUCTURAL SUBSET of
         `EntityListPanelProps` (the EntityControls reasoning, reused), so the
         panel's own control-strip host doubles as the tile host with no
         adapter. `kind` here is nominal — the block re-points it per row. */
      membersHost={{
        kind: detail.kind,
        rowsFor: () => [],
        ctx: props.ctx,
        ...(props.controls ?? {}),
        ...(props.livenessOf ? { livenessOf: props.livenessOf } : {}),
        ...(props.launch ? { launch: props.launch } : {}),
        ...(props.linkedPullRequestsOf
          ? { linkedPullRequestsOf: props.linkedPullRequestsOf }
          : {}),
        ...(onOpenEntity ? { onSelect: onOpenEntity } : {}),
      }}
    />
  );
}

/** Exported for the phone's action menu, which must show the SAME number the
    tab strip shows on a desktop — two derivations of one count is how the two
    surfaces start disagreeing about the same entity. */
export function countConnections(detail: EntityDetail, connections?: Connections): number {
  const groups = [
    ...(connections?.outgoing ?? detail.connections.outgoing),
    ...(connections?.incoming ?? detail.connections.incoming),
  ];
  return groups.reduce((n, g) => n + g.edges.length, 0);
}
