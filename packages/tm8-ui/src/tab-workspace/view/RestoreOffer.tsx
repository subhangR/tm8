/**
 * Two small persistence banners over the content area (Spec B §8, Spec A §12):
 *
 * - RESTORE OFFER: a new window (empty sessionStorage) whose `tm8.ws.last.v1`
 *   holds tabs offers "Restore N tabs from your last session" on the start
 *   surface. Restoring brings back state only — no Create, no Run, no prompt.
 * - SCOPE REPAIR: a restored By type selection lost every kind (outside D7).
 *   The scope is held at Mixed and this asks the person to pick kinds or keep
 *   Mixed, so Mixed is never chosen silently. Any scope commit clears it.
 *
 * The offer renders inline in the start surface's `restoreSlot` (above the
 * search). Scope repair stays an overlay in the content grid area, mounted by
 * `TabWorkspaceView`, because it can be needed whatever the content shows.
 */
import { useState, useSyncExternalStore } from 'react';
import { workspaceKindAdapters } from '../adapters/registry';
import {
  acceptRestoreOffer,
  dismissRestoreOffer,
  restoreOfferOf,
  subscribeRestoreOffer,
} from '../runtime/persistence';
import type { KindId } from '../runtime/types';
import { useWorkspace, useWorkspaceState } from './context';
import './restore-offer.css';

export function RestoreOffer() {
  const { runtime } = useWorkspace();
  const count = useSyncExternalStore(
    (listener) => subscribeRestoreOffer(runtime, listener),
    () => restoreOfferOf(runtime),
  );
  const onStart = useWorkspaceState((s) => s.presentation.surface === 'start' && s.orderedTabIds.length === 0);
  const repairing = useWorkspaceState((s) => s.scopeRepair !== undefined);

  // Repair outranks the offer: one question at a time.
  if (repairing || count === 0 || !onStart) return null;
  return (
    <div className="tws-restore-offer" role="status" data-testid="tws-restore-offer">
      <span className="tws-restore-offer-text">Restore {count === 1 ? '1 tab' : `${count} tabs`} from your last session?</span>
      <span className="tws-restore-offer-actions">
        <button type="button" className="tws-restore-offer-primary" onClick={() => acceptRestoreOffer(runtime)}>
          Restore
        </button>
        <button type="button" className="tws-restore-offer-later" onClick={() => dismissRestoreOffer(runtime)}>
          Not now
        </button>
      </span>
    </div>
  );
}

/** The scope-repair overlay; renders nothing unless a repair is pending. */
export function ScopeRepairBanner() {
  const repairing = useWorkspaceState((s) => s.scopeRepair !== undefined);
  return repairing ? <ScopeRepair /> : null;
}

function ScopeRepair() {
  const { dispatch } = useWorkspace();
  const [picked, setPicked] = useState<KindId[]>([]);
  const toggle = (kind: KindId) =>
    setPicked((ids) => (ids.includes(kind) ? ids.filter((id) => id !== kind) : [...ids, kind]));
  return (
    <div className="tws-banner tws-banner--repair" role="alertdialog" aria-label="Choose tab types" data-testid="tws-scope-repair">
      <span className="tws-banner-text">
        The tab types you filtered by are no longer available. Pick types, or show all tabs.
      </span>
      <div className="tws-banner-kinds" role="group" aria-label="Tab types">
        {workspaceKindAdapters().map((adapter) => (
          <button
            key={adapter.kind}
            type="button"
            className="tws-quiet-btn tws-banner-kind"
            aria-pressed={picked.includes(adapter.kind)}
            onClick={() => toggle(adapter.kind)}
          >
            {adapter.nounPlural}
          </button>
        ))}
      </div>
      <div className="tws-banner-actions">
        <button
          type="button"
          className="tws-quiet-btn tws-banner-primary"
          disabled={picked.length === 0}
          onClick={() =>
            dispatch({ command: 'workspace.tabScope.set', args: { mode: 'byType', selectedTypeIds: picked }, source: 'click' })
          }
        >
          Show selected types
        </button>
        <button
          type="button"
          className="tws-quiet-btn"
          onClick={() => dispatch({ command: 'workspace.tabScope.set', args: { mode: 'mixed' }, source: 'click' })}
        >
          Use Mixed
        </button>
      </div>
    </div>
  );
}
