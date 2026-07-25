/**
 * Gallery — the L1 exit-criteria page (gate G1) and Sentinel's audit surface:
 * every one of the 11 kinds rendered at Z1 (chip + inline ref), Z2 (card) and
 * Z3 (panel) from the seeded mock world, plus skeletons, the tombstone, badge
 * states, and live demos (hover → shared popover; panel tabs switch; chips
 * drag). Self-contained: it owns a seeded facade, providers, and store wiring,
 * so Atlas can mount <Gallery/> anywhere inside the standalone app.
 */
import { useEffect, useMemo, useState } from 'react';
import '../tokens.css';
import { Eyebrow, Kbd, PopoverProvider } from '../kit';
import { createSeededFacade } from '../mock';
import { KIND_ORDER, registryFor } from '../registry';
import {
  connectStores, useGraphStore, useNavStore, usePresenceStore,
} from '../stores';
import type { EntityDetail, EntityId, EntityKind, EntitySummary } from '../types/contract';
import {
  ChipSkeleton, CollabFacadeProvider, EntityCard, EntityCardSkeleton,
  EntityChip, EntityPanel, EntityPanelSkeleton, Tombstone,
} from '../entity';
import './gallery.css';

function seedIdForKind(ids: ReturnType<typeof createSeededFacade>['ids']): Record<EntityKind, EntityId> { // registry-purity: allow — seed-id storage keyed by kind, not behavior dispatch
  return {
    channel: ids.chBuild,
    task: ids.t103,
    message: ids.forgeProgressMessage,
    member: ids.subhang,
    team_member: ids.forge,
    doc: ids.docSpec,
    file: ids.fileWireframes,
    spell: ids.spellReviewer,
    skill: ids.skillGraphify,
    pull_request: ids.pr241,
    commit: ids.commitA1,
  };
}

function KindSection({ detail }: { detail: EntityDetail }) {
  const entry = registryFor(detail.kind);
  return (
    <section className="cv2g-kind" data-kind={detail.kind}>
      <div className="cv2g-kind__head">
        <Eyebrow>{entry.glyph} {entry.label} · {detail.kind}</Eyebrow>
      </div>
      <div className="cv2g-kind__grid">
        <div className="cv2g-cell">
          <span className="cv2g-cell__label">Z1 · chip</span>
          <div className="cv2g-cell__row"><EntityChip entity={detail} /></div>
          <span className="cv2g-cell__label">Z1 · inline ref</span>
          <div className="cv2g-cell__row">
            <span className="cv2g-proseline">
              …as discussed in <EntityChip entity={detail} variant="ref" /> yesterday.
            </span>
          </div>
        </div>
        <div className="cv2g-cell">
          <span className="cv2g-cell__label">Z2 · card</span>
          <EntityCard entity={detail} />
        </div>
        <div className="cv2g-cell cv2g-cell--panel">
          <span className="cv2g-cell__label">Z3 · panel</span>
          <EntityPanel entityId={detail.id} detail={detail} onClose={() => {}} />
        </div>
      </div>
    </section>
  );
}

export function Gallery() {
  const facade = useMemo(() => createSeededFacade({ latency: 0 }), []);
  const [details, setDetails] = useState<Partial<Record<EntityKind, EntityDetail>>>({}); // registry-purity: allow — kind-keyed storage, not dispatch
  const [badgeCases, setBadgeCases] = useState<EntitySummary[]>([]);
  const [tombstoned, setTombstoned] = useState<EntitySummary | null>(null);

  useEffect(() => {
    useGraphStore.getState().reset();
    usePresenceStore.getState().reset();
    const unsubscribe = connectStores(facade, facade.ids.space);
    useNavStore.getState().setSpace(facade.ids.space);

    const byKind = seedIdForKind(facade.ids);
    let cancelled = false;

    void (async () => {
      const loaded: Partial<Record<EntityKind, EntityDetail>> = {}; // registry-purity: allow — kind-keyed storage, not dispatch
      for (const kind of KIND_ORDER) {
        const detail = await facade.getEntity(byKind[kind]);
        loaded[kind] = detail;
        useGraphStore.getState().ingestDetail(detail);
      }
      // badge states: blocked (T-105 waits on hard deps) · stale pin (spec doc)
      const blocked = await facade.getEntity(facade.ids.t105);
      // tombstone: create a scratch task, soft-delete it, keep the summary
      const created = await facade.createTask({
        spaceId: facade.ids.space,
        title: 'Scratch task (gallery tombstone)',
        parentId: null,
      });
      let dead: EntitySummary | null = null;
      if (created.entity) {
        const res = await facade.deleteEntity(created.entity.id);
        dead = res.patches.find((p) => p.id === created.entity!.id && p.deletedAt != null)
          ?? useGraphStore.getState().entities[created.entity.id]
          ?? null;
      }
      if (cancelled) return;
      setDetails(loaded);
      setBadgeCases([blocked, loaded.doc!, loaded.task!]);
      setTombstoned(dead);
    })();

    return () => { cancelled = true; unsubscribe(); };
  }, [facade]);

  const ready = KIND_ORDER.every((k) => details[k]);

  return (
    <CollabFacadeProvider facade={facade}>
      <PopoverProvider>
        <div className="cv2-root cv2g">
          <header className="cv2g-header">
            <Eyebrow>collab v2 · layer 1 · entity component contract</Eyebrow>
            <h1 className="t-h1">The Gallery</h1>
            <p className="t-body cv2g-lede">
              Every kind × every zoom level, rendered by ONE component system from the
              seeded mock world. Hover any chip for the Z2 popover (shared engine, single
              instance), click panel tabs to switch sections, drag chips to feel the
              payload. Kinds are data: each row below exists because of a registry entry,
              nothing else. <Kbd>hover</Kbd> <Kbd>click</Kbd> <Kbd>drag</Kbd>
            </p>
          </header>

          {!ready && (
            <section className="cv2g-kind">
              <Eyebrow>loading seeded world…</Eyebrow>
              <div className="cv2g-kind__grid">
                <div className="cv2g-cell"><ChipSkeleton /></div>
                <div className="cv2g-cell"><EntityCardSkeleton /></div>
                <div className="cv2g-cell cv2g-cell--panel"><EntityPanelSkeleton /></div>
              </div>
            </section>
          )}

          {ready && KIND_ORDER.map((kind) => (
            <KindSection key={kind} detail={details[kind]!} />
          ))}

          {ready && (
            <section className="cv2g-kind" data-section="badges">
              <Eyebrow>§11 states · blocked ⚠ · stale pin · working ●</Eyebrow>
              <div className="cv2g-badges">
                {badgeCases.map((s) => <EntityCard key={s.id} entity={s} />)}
              </div>
            </section>
          )}

          <section className="cv2g-kind" data-section="skeletons">
            <Eyebrow>loading states · skeletons (panels never blank-flash)</Eyebrow>
            <div className="cv2g-kind__grid">
              <div className="cv2g-cell">
                <span className="cv2g-cell__label">Z1</span>
                <div className="cv2g-cell__row"><ChipSkeleton /></div>
              </div>
              <div className="cv2g-cell">
                <span className="cv2g-cell__label">Z2</span>
                <EntityCardSkeleton />
              </div>
              <div className="cv2g-cell cv2g-cell--panel">
                <span className="cv2g-cell__label">Z3</span>
                <EntityPanelSkeleton />
              </div>
            </div>
          </section>

          {tombstoned && (
            <section className="cv2g-kind" data-section="tombstone">
              <Eyebrow>deleted (soft) · tombstones keep history shape</Eyebrow>
              <div className="cv2g-kind__grid">
                <div className="cv2g-cell">
                  <span className="cv2g-cell__label">chip</span>
                  <div className="cv2g-cell__row"><Tombstone entity={tombstoned} variant="chip" /></div>
                </div>
                <div className="cv2g-cell">
                  <span className="cv2g-cell__label">card</span>
                  <Tombstone entity={tombstoned} variant="card" />
                </div>
              </div>
            </section>
          )}
        </div>
      </PopoverProvider>
    </CollabFacadeProvider>
  );
}

export default Gallery;
