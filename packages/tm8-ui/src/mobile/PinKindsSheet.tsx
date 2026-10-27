/**
 * PIN KINDS — the phone's door to the desktop rail's pins (drawer mockup v3,
 * task 01a14ccc).
 *
 * ONE PREFERENCE, TWO SHELLS. Every switch here calls the SAME
 * `railStore.togglePin` the desktop rail's press-and-hold calls, so a kind
 * pinned on the phone is pinned on the desktop column and the other way round.
 * The sheet keeps no copy of the pins; it subscribes, so the drawer's Pinned
 * section underneath moves as each switch is flipped.
 *
 * The drawer's tree kinds (`drawerTreeKinds()`) are drawn on every phone
 * regardless, so they read "always shown" rather than offering a switch that
 * would change nothing on this screen. Their desktop pins are left alone.
 */
import { useMemo } from 'react';
import { useStore } from 'zustand';

import { KindIcon, drawerTreeKinds, homeRailGroups, type KindConfig } from '../domain';
import { getRailStore } from '../tab-workspace/runtime/railStore';
import { MobileSheet } from './MobileSheet';
import './pin-kinds.css';

export interface PinKindsSheetProps {
  readonly spaceId: string;
  readonly onDismiss: () => void;
}

export function PinKindsSheet({ spaceId, onDismiss }: PinKindsSheetProps) {
  const store = useMemo(() => getRailStore(spaceId), [spaceId]);
  const pins = useStore(store, (state) => state.pins);
  const { fixed, toggleable } = useMemo(() => {
    const fixed = drawerTreeKinds();
    const shown = new Set(fixed.map((config) => config.kind));
    /* Every other kind in the desktop rail's own group order, flattened: the
       mockup draws one list, and nine group labels in a 72% sheet would be
       more heading than switch. */
    const toggleable = homeRailGroups()
      .flatMap((group) => group.kinds)
      .filter((config) => !shown.has(config.kind));
    return { fixed, toggleable };
  }, []);

  return (
    <MobileSheet title="Pin kinds" onDismiss={onDismiss} testId="mobile-pin-kinds">
      <div className="mpins">
        <p className="mpins__lede">Pinned kinds appear under the trees and match your desktop rail pins.</p>
        <ul className="mpins__list">
          {fixed.map((config) => (
            <li key={config.kind} className="mpins__row" data-kind={config.kind}>
              <KindMark config={config} />
              <span className="mpins__fixed">always shown</span>
            </li>
          ))}
          {toggleable.map((config) => {
            const pinned = pins.includes(config.kind);
            return (
              <li key={config.kind}>
                <button
                  type="button"
                  role="switch"
                  aria-checked={pinned}
                  className="mpins__row mpins__row--toggle"
                  data-kind={config.kind}
                  data-testid={`mobile-pin-kind-${config.kind}`}
                  onClick={() => store.getState().togglePin(config.kind)}
                >
                  <KindMark config={config} />
                  <span className="mpins__switch" aria-hidden />
                </button>
              </li>
            );
          })}
        </ul>
      </div>
    </MobileSheet>
  );
}

function KindMark({ config }: { config: KindConfig }) {
  return (
    <>
      <span className="mpins__mark" aria-hidden>
        <KindIcon kind={config.kind} size={16} />
      </span>
      <span className="mpins__name">{config.labelPlural}</span>
    </>
  );
}
