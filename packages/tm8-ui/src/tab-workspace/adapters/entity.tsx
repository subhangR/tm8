/**
 * Generic entity adapter (Spec B §6): renders the kind's chosen body
 * (fullView renderer, or the EntityDetailPanel body without its chrome) and
 * exposes `captureUi()` / `restoreUi(ui)` for scroll. STUB — the Content
 * workstream (E) fills in the body.
 */
import type { EntityTabRecord, TabUi } from '../runtime/types';
import type { KindAdapter } from './registry';

export interface EntityAdapterHandle {
  captureUi(): Partial<TabUi>;
  restoreUi(ui: TabUi): void;
}

export interface EntityTabBodyProps {
  tab: EntityTabRecord;
  adapter: KindAdapter;
  /** Registers the mounted body's capture/restore handle; null on unmount. */
  onHandle?: (handle: EntityAdapterHandle | null) => void;
}

export function EntityTabBody({ tab, adapter }: EntityTabBodyProps) {
  return (
    <div className="tws-body-stub" data-testid="tws-entity-body" data-kind={tab.kind} data-body={adapter.body}>
      <p className="tws-quiet">
        {adapter.noun} {tab.entityId} — {tab.ui.subview}
      </p>
    </div>
  );
}
