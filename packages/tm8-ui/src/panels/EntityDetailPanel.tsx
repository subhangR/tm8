import { useState, type ReactNode } from 'react';
import type {
  ActivityItem,
  CommandResult,
  Connections,
  EntityDetail,
  HandoffView,
  MessageView,
  WorkSessionInteractionProfileProjection,
} from '@tm8/contract';
import type { SessionLiveness } from '../data/seam';
import type { ContentSurface } from '../routes';
import type { ActionContext, ActionRef, ContentBlockRef, KindConfig } from '../domain';
import { getKind } from '../domain';
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
  type PanelHost,
  type PanelTab,
} from './detail/chrome';
import {
  ErrorBody,
  LoadingBody,
  PermissionLostPanel,
  StalePinBanner,
  TombstoneBody,
} from './detail/PanelStates';
import { ActivityTab, ConnectionsTab, DiscussionTab } from './detail/tabs';
import { CatchBoundary } from './detail/CatchBoundary';
import { EntityControlStrip, type ControlHost, type ControlSubject } from './controls/EntityControls';
import { GenericBody, type ArtifactPreviewCommands } from './bodies/GenericBody';
import { TerminalBody } from './bodies/TerminalBody';
import { SubtreeBody } from './bodies/SubtreeBody';
import { ReaderSurface } from './bodies/ReaderSurface';
import type { DocCommands } from '../doc-edit';
import { HubBody } from './bodies/HubBody';
import { ProfileBody } from './bodies/ProfileBody';
import { GovernedBody } from './bodies/GovernedBody';
import { RestrictedBody } from './bodies/RestrictedBody';
import { WorkSessionContent } from './bodies/WorkSessionContent';
import { AttachmentStrip } from '../files/AttachmentStrip';
import { attachedFiles } from '../files/model';
import type { AttachmentsPort } from '../files/port';

/**
 * EntityDetailPanel — one of the two universal primitives (L3).
 *
 * ONE COMPONENT RENDERS EVERY KIND. The anatomy is fixed (header → action bar
 * → four tabs → footer); the ONLY per-kind region is the Content body, and
 * which body that is comes from `registry(kind).panel.archetype` — registry
 * DATA. There is no `kind ===` anywhere in this file, and there cannot be:
 * §15.2 fails the build on one.
 *
 * D3 — FOUR TABS ALWAYS. Content · Discussion · Connections · Activity, fixed
 * order, every kind, no exceptions. It costs almost nothing because three of
 * the four are kind-agnostic by construction (see detail/tabs.tsx).
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
 * Does this kind declare anything for the strip to draw?
 *
 * REGISTRY DATA, NOT A KIND LIST. A doc declares none of the three and gets no
 * strip; a task declares all three and gets all three; a kind that grows a
 * second `ValueControl` tomorrow gets it here with no edit to this file. The
 * archive verb alone is NOT enough to mount the strip — every kind has a
 * tombstone, so keying on that would put a bare Archive bar under every panel
 * in the app, which is a redesign and not this fix.
 */
function controlsFor(config: KindConfig): boolean {
  const list = config.list;
  return (
    list.stateControl !== undefined ||
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
    deletedAt: detail.deletedAt,
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
  activity?: readonly ActivityItem[];
  connections?: Connections;
  authoredFrom?: Readonly<Record<string, string | null>>;

  /** work_session inputs — ignored by every other archetype. */
  handoffs?: readonly HandoffView[];
  liveness?: SessionLiveness;
  /** Verdicts for RELATED session rows (SubtreeBody RUNS, ProfileBody RECENT
      SESSIONS) — same seam source as `liveness`, per-id. Optional: an absent
      map renders those rows' liveness as unverified, never as live. */
  livenessOf?: (id: string) => SessionLiveness;
  /** The composer's dispatcher — absent ⇒ composer disabled-with-reason. */
  onPostMessage?: (body: string) => Promise<void> | void;
  /**
   * Resume this exited/failed work session. Absent ⇒ the exited card renders
   * its Resume button DISABLED with a reason, never hidden — a missing button
   * would claim the session is unresumable rather than unwired.
   */
  onResumeSession?: () => void;
  /** True while that resume is in flight. */
  resumingSession?: boolean;
  streaming?: boolean;
  needsAttention?: boolean;
  attentionDetail?: string;
  /** Viewer-local presentation state for the two work-session Content panes. */
  contentSurface?: ContentSurface | null;
  viewerMemberId?: string | null;
  chatSurface?: ReactNode;
  /** The DEBUG surface (session CLI journal). Self-fetching; host wires the seam. */
  debugSurface?: ReactNode;
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
   * Before this prop existed the panel drew `workStatus` as a read-only header
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
  onAction?: (ref: ActionRef) => void;
  onOpenEntity?: (id: string) => void;
  onRetry?: () => void;
}

export function EntityDetailPanel(props: EntityDetailPanelProps) {
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
  const tab = activeTab ?? uncontrolledTab;

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
   * THE CONTROL STRIP — ONE ROW, UNDER THE TABS.
   *
   * USER RULING 2026-08-05, on the task panel, verbatim: "the top part is
   * showing the drop downs in vertical, they should be in a single row … below
   * the tabs (task, discussion, connections, activity) a row with these drop
   * downs."
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
   * THE TERMINAL ARCHETYPE KEEPS THE OLD POSITION, and that is structural,
   * not an exception carved for a kind: a terminal panel owns its full height
   * below the tabs (user ruling 2026-07-31, "terminal all the way, till the
   * component bottom"), so there is no band under the tabs to put a row in.
   *
   * NOT ON A TOMBSTONE. A deleted entity cannot be edited (the server refuses,
   * and `useTaskSave` already says "restore it before editing"), and its ONE
   * live verb is restore — which `TombstoneBody` owns below. Rendering the
   * strip here too would put two restore controls in one panel, which is the
   * duplication D67 removed from the tile.
   */
  const strip =
    controlsFor(config) && !isTombstone ? (
      <EntityControlStrip
        row={subjectOf(detail)}
        props={props.controls ?? { kind: detail.kind, ctx: props.ctx }}
        config={config}
        variant={isTerminal ? 'lines' : 'chips'}
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
      data-testid="entity-detail-panel"
      data-host={host}
      data-archetype={config.panel.archetype}
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
        onCommitTitle={(title) => void save.commitNow({ title })}
      />

      {/* The terminal archetype's only possible position; see `strip` above. */}
      {isTerminal ? strip : null}

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
          <>
            {isTerminal ? (
              <div
                className="pn-panelbar__surface"
                ref={setSurfaceSlot}
                data-testid="panel-surface-slot"
              />
            ) : null}
            <ActionBar
              config={config}
              ctx={{
                ...ctx,
                entityId: ctx.entityId ?? detail.id,
                kind: ctx.kind ?? detail.kind,
                capabilities: ctx.capabilities ?? detail.capabilities,
                liveness: ctx.liveness ?? props.liveness,
              }}
              onAction={props.onAction}
            />
            {config.list.inlineEdit?.title || config.list.inlineEdit?.status ? (
              <SaveControls save={save} />
            ) : null}
            <PanelWindowControls
              onPromote={props.onPromote}
              onClose={onClose}
            />
          </>
        }
        onSelect={selectTab}
      />

      {/* The band is gated on the strip, not just on the archetype: a kind with
          no controls (a doc declares none) would otherwise draw an empty
          padded row with a hairline under the tabs. */}
      {strip && !isTerminal ? (
        <div className="pn-controls" data-testid="panel-controls">
          {strip}
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
            <PanelBody {...props} detail={detail} tab={tab} save={save} surfaceSlot={surfaceSlot} />
            {/*
              ATTACHMENTS RIDE IN THE CONTENT BODY — not in a fifth tab. D3
              fixes the panel at four tabs for every kind (user ruling
              2026-08-01), and the content body is the one region allowed to
              vary. Rendered HERE rather than inside each archetype arm so it
              is genuinely kind-agnostic: one mount serves task, doc,
              work_session and every custom kind, and no future archetype can
              forget to include it.

              TWO EXCLUSIONS, both structural, neither a kind check. The
              terminal archetype owns its full height (a live PTY canvas with a
              strip stapled under it is not a design, it is a leak), and a
              tombstone shows only its tombstone.
            */}
            {tab === 'content' && !isTombstone && config.panel.archetype !== 'terminal' ? (
              <AttachmentStrip
                anchorId={detail.id}
                files={attachedFiles(detail)}
                downloadHref={props.attachments?.downloadHref}
                startUpload={props.attachments?.startUpload}
                onUploaded={props.onAttachmentUploaded}
                onDetach={props.attachments?.detach}
                /* A detach and an upload change the SAME thing — the anchor's
                   `attached_to` edges — so they share one refetch, and a host
                   cannot wire adding without also wiring removing. */
                onDetached={props.onAttachmentUploaded}
              />
            ) : null}
          </AuthoringHost>
        </CatchBoundary>
      )}

      {/* USER RULING 2026-07-31 — "terminal all the way, till the component
          bottom." The footer is the last strip between the canvas and the
          panel edge, so terminal panels do without it. It stays for every
          other archetype: the reading it carries (presence · author · version)
          is honest chrome for a document, and only the terminal has a primary
          surface whose whole value is the pixels this row was taking. */}
      {isTerminal ? null : (
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
  },
) {
  const { detail, tab, reasons, onOpenEntity, save } = props;
  const config = getKind(detail.kind);
  const saveRefusal = refusalSentence(save);
  const startUpload = props.attachments?.startUpload;

  if (tab === 'discussion') {
    return (
      <DiscussionTab
        messages={props.messages ?? []}
        provenanceHollowReason={reasons.provenanceHollow}
        authoredFrom={props.authoredFrom}
        canPost={detail.capabilities.canEdit || detail.capabilities.canReact}
        onPost={props.onPostMessage}
      />
    );
  }
  if (tab === 'connections') {
    return <ConnectionsTab detail={detail} connections={props.connections} onOpenEntity={onOpenEntity} />;
  }
  if (tab === 'activity') {
    return <ActivityTab items={props.activity ?? []} />;
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
          <TerminalBody
            detail={detail}
            serverBaseUrl={props.serverBaseUrl}
            liveness={props.liveness ?? 'unknown'}
            streaming={props.streaming}
            needsAttention={props.needsAttention}
            attentionDetail={props.attentionDetail}
            handoffs={props.handoffs}
            shareUnavailableReason={reasons.shareUnavailable}
            withdrawUnavailableReason={reasons.withdrawUnavailable}
            livenessLabel={config.list.liveTreatment?.(props.liveness ?? 'unknown').label}
            livenessReason={config.list.liveTreatment?.(props.liveness ?? 'unknown').reason}
            onOpenEntity={onOpenEntity}
            {...(props.onResumeSession ? { onResume: props.onResumeSession } : {})}
            {...(props.resumingSession ? { resuming: props.resumingSession } : {})}
          />
        }
        chat={props.chatSurface ?? (
          <p className="pn-surface-host-missing" role="alert">
            Chat is enabled for this session, but its feed host is unavailable.
          </p>
        )}
        debug={props.debugSurface ?? (
          <p className="pn-surface-host-missing" role="alert">
            The debug journal host is unavailable in this view.
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
     * `chatSurface` is the same prop the terminal arm consumes: one host slot
     * for "the live conversation for this entity", not a second channel-shaped
     * one.
     */
    return (
      <>
        <HubBody
          detail={detail}
          blocks={config.panel.blocks ?? []}
          messages={props.messages}
          hasFeed={props.chatSurface != null}
          onOpenEntity={onOpenEntity}
        />
        {props.chatSurface ? <div className="pn-hub-feed">{props.chatSurface}</div> : null}
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
      commands={props.commands}
      downloadHref={props.attachments?.downloadHref}
    />
  );
}

function countConnections(detail: EntityDetail, connections?: Connections): number {
  const groups = [
    ...(connections?.outgoing ?? detail.connections.outgoing),
    ...(connections?.incoming ?? detail.connections.incoming),
  ];
  return groups.reduce((n, g) => n + g.edges.length, 0);
}
