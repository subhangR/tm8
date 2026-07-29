/**
 * EntityView — the per-kind screen every rail kind-row opens (USER RULING
 * 2026-07-29, D65): the workspace is the ONLY three-panel exception; every
 * other entity screen is a WIDE LIST in the middle with a detail panel that
 * opens to the RIGHT of it on row click, because the user still wants the
 * list while reading the entity.
 *
 * TWO DETAIL LEVELS, both from the T0-4 canvas (canvas-T0-4.md):
 *   Z3 ASIDE — the panel beside the list: peek ≈440px, floor 320 (the same
 *     Z3 the workspace stacks; one component, second host).
 *   Z4 FULL — `⤢ promote` expands LEFTWARD TO THE MENU RAIL: full-bleed on
 *     --pn-paper, a 42px full-view header (`⇲ collapse` chip · breadcrumb
 *     `{kind} · full view` · `esc` hint), reading column max-width 700px.
 *     The six per-archetype Z4 layouts (subtree/reader/hub/profile/generic/
 *     terminal) are a LATER PASS — v1 hosts the Z3 panel's content in the
 *     Z4 shell, stated here so nobody reads the interim as the design.
 *
 * Esc walks the ladder down: full → aside → list only. The aside's ✕ closes
 * it; the list row stays selected-highlighted while its entity is open.
 *
 * Sessions are entities like everything else here (user ruling) — a session
 * opened in this view renders its terminal body in the aside, and expanding
 * gives the terminal the whole width, which is D63's "nothing outbids the
 * terminal" carried to its natural end.
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import type { EntityId } from '@tm8/contract';
import { EntityDetailPanel, type DetailReasons } from '../panels';
import { EntityTree } from './EntityTree';
import type { ActionContext } from '../domain/types';
import { getKind } from '../domain/registry';
import { NewTaskControl, placeholderTitleFor, useNewTask } from '../authoring';
import type { Notice } from '../shell/notices';
import type { GateData } from './useGateData';
import './entity-view.css';

export interface EntityViewProps {
  data: GateData & { pull?: (id: string) => void };
  kind: string;
  reasons: DetailReasons;
  onNotice(notice: Notice): void;
  /** The rail row is the source of truth for WHICH kind; the in-panel kind
      switcher re-routes through it so the rail highlight never lies. */
  onKindChange?(kind: string): void;
}

type DetailMode = 'aside' | 'full';

export function EntityView(props: EntityViewProps) {
  const { data, kind, reasons } = props;

  const [selectedId, setSelectedId] = useState<EntityId | null>(null);
  const [mode, setMode] = useState<DetailMode>('aside');

  // A kind switch is a NEW screen: carrying a selection across kinds would
  // show a doc in the "Tasks" view's aside — a true panel about the wrong
  // screen. Reset on kind, deliberately.
  useEffect(() => {
    setSelectedId(null);
    setMode('aside');
  }, [kind]);

  useEffect(() => {
    data.ensureKind(kind);
  }, [data, kind]);

  const ctx = useMemo<ActionContext>(() => ({ spaceId: data.spaceId }), [data.spaceId]);
  const config = getKind(kind);

  /* Authoring mount 7a, EntityView host: +New in the tree head creates for
     real and opens the new entity in the aside. quickCreate gates by
     registry data. */
  const createFlow = useNewTask({
    spaceId: data.spaceId,
    placeholderTitle: placeholderTitleFor(config.label),
    commands: data.seam.commands,
    onCreated: (id) => setSelectedId(id as EntityId),
  });

  // Esc walks DOWN one level per press — the canvas's own law for Z4
  // ("⇲ collapse / esc returns to the panel"), extended one rung to the list.
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || selectedId === null) return;
      // A focused terminal or an open sheet owns its own Esc; only act when
      // the event reaches the document unclaimed.
      if (event.defaultPrevented) return;
      event.preventDefault();
      if (mode === 'full') setMode('aside');
      else setSelectedId(null);
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [selectedId, mode]);

  const openEntity = useCallback((id: EntityId) => {
    setSelectedId(id);
  }, []);

  const detail = selectedId ? data.detailOf(selectedId) : null;
  if (selectedId && !detail) props.data.pull?.(selectedId);

  const detailPanel = selectedId ? (
    <EntityDetailPanel
      detail={detail ?? null}
      loading={!detail}
      host="stack"
      reasons={reasons}
      ctx={{ ...ctx, entityId: selectedId }}
      pinned={false}
      // Pinning belongs to the workspace's stack economy; here the panel HAS
      // a permanent slot, so the verb is refused with the true reason rather
      // than hidden (L6).
      pinRefusal="Pinning lives in the Workspace — this view keeps the panel beside the list already"
      liveness={data.livenessOf(selectedId)}
      livenessOf={data.livenessOf}
      messages={data.messagesOf(selectedId)}
      onPostMessage={(body) => data.postMessage({ clientMutationId: `post:${selectedId}:${Date.now()}`, anchorIds: [selectedId], body })}
      streaming={data.activity[selectedId] ?? false}
      onPromote={() => setMode((m) => (m === 'aside' ? 'full' : 'aside'))}
      onClose={() => {
        setSelectedId(null);
        setMode('aside');
      }}
    />
  ) : null;

  /* USER REFINEMENT 2026-07-29 (supersedes the full-bleed Z4 v1): the page
   * behaves RESPONSIVELY and the list NEVER leaves the screen —
   *   list  : the tree rides CENTERED in the middle;
   *   aside : the panel opens right (Z3 ≈440), the tree stays centered in
   *           what remains;
   *   full  : the tree yields to a NARROW LEFT COLUMN and the entity takes
   *           the entire remaining width (the Z4 header — ⇲ collapse,
   *           breadcrumb, esc — rides on the expanded region, not over the
   *           list).
   */
  const layoutMode = selectedId ? mode : 'list';
  return (
    <div className="ev-root" data-testid="entity-view" data-kind={kind} data-mode={layoutMode}>
      <div className="ev-split" data-mode={layoutMode}>
        <section
          className={`ev-list ev-list--${layoutMode}`}
          aria-label={`${config.labelPlural} list`}
        >
          {/* USER RULING (same day, refining D65): the middle is its OWN
              wide component — an expandable tree — never the side
              EntityListPanel stretched. */}
          <EntityTree
            kind={kind}
            createSlot={
              config.list.quickCreate ? (
                <NewTaskControl flow={createFlow} label={config.palette?.createLabel ?? '＋ New'} />
              ) : undefined
            }
            rowsFor={data.rowsFor(kind)}
            livenessOf={data.livenessOf}
            activity={data.activity}
            selectedId={selectedId}
            onSelect={(id) => openEntity(id as EntityId)}
          />
        </section>

        {selectedId && mode === 'aside' ? (
          <aside className="ev-aside" aria-label={`${config.label} details`} data-testid="entity-view-aside">
            {detailPanel}
          </aside>
        ) : null}

        {selectedId && mode === 'full' ? (
          <div className="ev-expanded" data-testid="entity-view-full">
            <div className="ev-full__head">
              <button
                type="button"
                className="ev-full__collapse"
                onClick={() => setMode('aside')}
                aria-label="Collapse to panel"
              >
                ⇲ collapse
              </button>
              <span className="ev-full__crumb">{`${config.labelPlural.toLowerCase()} · full view`}</span>
              <span className="ev-full__spacer" />
              <span className="ev-full__esc">esc</span>
            </div>
            <div className="ev-full__body">{detailPanel}</div>
          </div>
        ) : null}
      </div>
    </div>
  );
}
