/**
 * PointsControl — one button, three gestures:
 *   · TAP    → +1 point
 *   · HOLD   → the amount picker (presets + a custom amount)
 *   · HOVER  → the pool popover: total + top granters
 *
 * The picker is also reachable from the keyboard (a caret button and
 * ArrowDown on the main control), because "hold" is not an accessible
 * gesture on its own.
 */
import { useEffect, useRef, useState } from 'react';
import { Avatar, usePopover } from '../../kit';
import { HOLD_MS, POINT_PRESETS, type Granter } from './model';

export interface PointsControlProps {
  pool: number;
  disabled?: boolean;
  onGrant: (amount: number) => void;
  /** Resolves the pool's top granters; called when the hover card mounts. */
  loadGranters: () => Promise<Granter[]>;
  /** Test/tuning hooks. */
  holdMs?: number;
  popoverDelayMs?: number;
  size?: 'sm' | 'md';
}

/**
 * The hover card owns its own async state: the popover engine snapshots the
 * node it is handed, so data that arrives later has to arrive *inside* it.
 */
function PoolCard({ pool, load }: { pool: number; load: () => Promise<Granter[]> }) {
  const [granters, setGranters] = useState<Granter[] | null>(null);

  useEffect(() => {
    let cancelled = false;
    void load().then((list) => { if (!cancelled) setGranters(list); });
    return () => { cancelled = true; };
  }, [load]);

  return (
    <div className="cv2-points__pool">
      <span className="cv2-eyebrow">Points pool</span>
      <strong className="cv2-points__pooltotal">{pool}</strong>
      {granters == null && <p className="cv2-empty-line">Loading granters…</p>}
      {granters != null && granters.length === 0 && <p className="cv2-empty-line">No grants yet.</p>}
      {granters != null && granters.length > 0 && (
        <ul className="cv2-points__granters">
          {granters.map((g) => (
            <li key={g.actor.id}>
              <Avatar actor={g.actor} size={16} />
              <span>{g.actor.displayName}</span>
              <span className="cv2-points__granteramount">+{g.amount}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

export function PointsControl({
  pool, disabled = false, onGrant, loadGranters,
  holdMs = HOLD_MS, popoverDelayMs, size = 'md',
}: PointsControlProps) {
  const popover = usePopover();
  const [picking, setPicking] = useState(false);
  const [custom, setCustom] = useState('');
  const holdTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const heldRef = useRef(false);
  const btnRef = useRef<HTMLButtonElement>(null);

  useEffect(() => () => { if (holdTimer.current) clearTimeout(holdTimer.current); }, []);

  const clearHold = (): void => {
    if (holdTimer.current) { clearTimeout(holdTimer.current); holdTimer.current = null; }
  };

  const openPicker = (): void => {
    popover.close();
    setPicking(true);
  };

  const startHold = (): void => {
    if (disabled) return;
    heldRef.current = false;
    clearHold();
    holdTimer.current = setTimeout(() => {
      heldRef.current = true;
      openPicker();
    }, holdMs);
  };

  const endHold = (): void => clearHold();

  const grant = (amount: number): void => {
    setPicking(false);
    setCustom('');
    popover.close();
    onGrant(amount);
  };

  return (
    <span className="cv2-points" data-size={size}>
      <button
        ref={btnRef}
        type="button"
        className="cv2-points__btn"
        aria-label="Grant a point"
        title={`Grant a point · hold to choose an amount · pool ${pool}`}
        disabled={disabled}
        onPointerDown={startHold}
        onPointerUp={endHold}
        onPointerLeave={() => { endHold(); popover.cancel(); }}
        onPointerCancel={endHold}
        onMouseEnter={(e) => {
          popover.open(e.currentTarget, <PoolCard pool={pool} load={loadGranters} />,
            popoverDelayMs != null ? { delayMs: popoverDelayMs } : undefined);
        }}
        onClick={() => {
          if (heldRef.current) { heldRef.current = false; return; } // the hold opened the picker
          onGrant(1);
        }}
        onKeyDown={(e) => {
          if (e.key === 'ArrowDown') { e.preventDefault(); openPicker(); }
        }}
      >
        <span aria-hidden="true">◈</span>
        <span className="cv2-actioncount">{pool}</span>
      </button>
      <button
        type="button"
        className="cv2-points__caret"
        aria-label="Choose point amount"
        aria-expanded={picking}
        disabled={disabled}
        onClick={() => (picking ? setPicking(false) : openPicker())}
      >
        ▾
      </button>

      {picking && (
        <div className="cv2-points__picker" role="menu" aria-label="Point amount">
          {POINT_PRESETS.map((amount) => (
            <button
              key={amount}
              type="button"
              role="menuitem"
              className="cv2-points__preset"
              onClick={() => grant(amount)}
            >
              +{amount}
            </button>
          ))}
          <form
            className="cv2-points__customrow"
            onSubmit={(e) => {
              e.preventDefault();
              const amount = Number.parseInt(custom, 10);
              if (Number.isFinite(amount) && amount > 0) grant(amount);
            }}
          >
            <input
              className="cv2-points__input"
              type="number"
              min={1}
              aria-label="Custom point amount"
              value={custom}
              onChange={(e) => setCustom(e.target.value)}
            />
            <button type="submit" className="cv2-actionbtn">Grant</button>
          </form>
          <button
            type="button"
            className="cv2-points__preset"
            onClick={() => { setPicking(false); btnRef.current?.focus(); }}
          >
            Cancel
          </button>
        </div>
      )}
    </span>
  );
}
