import { useState } from 'react';
import type { ActivityItem, Connections, EntityDetail, HandoffView, MessageView } from '@tm8/contract';
import type { SessionLiveness } from '../data/seam';
import type { ActionContext, ActionRef, ContentBlockRef } from '../domain';
import { getKind } from '../domain';
import { ActionBar, PanelFooter, PanelHeader, TabStrip, type PanelHost, type PanelTab } from './detail/chrome';
import {
  ErrorBody,
  LoadingBody,
  PermissionLostPanel,
  StalePinBanner,
  TombstoneBody,
} from './detail/PanelStates';
import { ActivityTab, ConnectionsTab, DiscussionTab } from './detail/tabs';
import { CatchBoundary } from './detail/CatchBoundary';
import { GenericBody } from './bodies/GenericBody';
import { TerminalBody } from './bodies/TerminalBody';
import { SubtreeBody } from './bodies/SubtreeBody';
import { ReaderBody } from './bodies/ReaderBody';
import { HubBody } from './bodies/HubBody';
import { ProfileBody } from './bodies/ProfileBody';

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
  streaming?: boolean;
  needsAttention?: boolean;
  attentionDetail?: string;

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
  const selectTab = (t: PanelTab) => {
    setUncontrolledTab(t);
    onTabChange?.(t);
  };

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
  const alwaysDark = config.panel.archetype === 'terminal';

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
        pinned={props.pinned}
        pinRefusal={props.pinRefusal}
        onPin={props.onPin}
        onPromote={props.onPromote}
        onClose={onClose}
        /*
          USER RULING 2026-07-29: two-row chrome — the action bar rides inline
          in the header row; the standalone 32px row is gone and its height
          belongs to the body (the terminal, on the session screen).

          THE PANEL HOLDS THESE FACTS AND MUST HAND THEM DOWN. Passing the
          caller's raw context left the liveness gate reading undefined and the
          capability gate reading null, so a fully-loaded stale session showed
          "waiting for this entity to load" and "liveness is unverified" while
          the chrome strip three lines below rendered the verdict correctly. The
          two consumers never disagreed — one was simply never wired.
        */
        actions={
          <ActionBar
            detail={detail}
            config={config}
            inline
            ctx={{
              ...ctx,
              entityId: ctx.entityId ?? detail.id,
              kind: ctx.kind ?? detail.kind,
              capabilities: ctx.capabilities ?? detail.capabilities,
              liveness: ctx.liveness ?? props.liveness,
            }}
            onAction={props.onAction}
          />
        }
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
        onSelect={selectTab}
      />

      {/* The error boundary wraps the BODY only: header, tabs and footer stay
          live so close, pin and Esc keep working through a failed render.
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
          <PanelBody {...props} detail={detail} tab={tab} />
        </CatchBoundary>
      )}

      <PanelFooter
        detail={detail}
        presenceHollowReason={reasons.presenceHollow}
        versionHistoryReason={reasons.versionHistory}
      />
    </section>
  );

}

function PanelBody(props: EntityDetailPanelProps & { detail: EntityDetail; tab: PanelTab }) {
  const { detail, tab, reasons, onOpenEntity } = props;
  const config = getKind(detail.kind);

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
        deletedBy={detail.createdBy.displayName}
        canRestore={detail.capabilities.canDelete}
      />
    );
  }

  /**
   * THE ONLY PER-KIND SWITCH IN THE PANEL — and it is on ARCHETYPE, a
   * registry field, not on kind. Fifteen kinds, six archetypes, one switch.
   */
  if (config.panel.archetype === 'terminal') {
    return (
      <TerminalBody
        detail={detail}
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
      />
    );
  }
  if (config.panel.archetype === 'reader') {
    return (
      <ReaderBody
        detail={detail}
        blocks={config.panel.blocks ?? []}
        historyUnavailableReason={reasons.versionHistory}
        onOpenEntity={onOpenEntity}
      />
    );
  }
  if (config.panel.archetype === 'hub') {
    return (
      <HubBody
        detail={detail}
        blocks={config.panel.blocks ?? []}
        messages={props.messages}
        onOpenEntity={onOpenEntity}
      />
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

  return (
    <GenericBody
      detail={detail}
      blocks={config.panel.blocks ?? DEFAULT_BLOCKS}
      onOpenEntity={onOpenEntity}
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
