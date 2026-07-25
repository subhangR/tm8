/**
 * The mode banner. Small, permanent, and non-negotiable.
 *
 * The single most dangerous outcome of this transplant would be a screen a
 * viewer cannot classify — mock data that reads as real, or real data with
 * mock-shaped gaps that reads as broken. So the app states which world it is
 * in, at all times, in a place you cannot scroll away from.
 *
 * REAL mode additionally states the size of the gap (how many facade methods
 * have no server behind them) rather than leaving "why is this list empty?" to
 * be discovered by clicking.
 */
import { unavailableCount } from './capabilities';

export type FacadeMode = 'real' | 'mock';

export function ModeBanner({
  mode, detail, connected,
}: {
  mode: FacadeMode;
  /** Server origin in real mode; the seed name in mock mode. */
  detail: string;
  connected?: boolean;
}) {
  const real = mode === 'real';
  const offline = real && connected === false;

  const background = offline ? '#7f1d1d' : real ? '#064e3b' : '#78350f';
  const label = offline
    ? 'REAL SERVER — UNREACHABLE'
    : real
      ? 'REAL SERVER'
      : 'MOCK DATA — NOT A REAL SERVER';

  return (
    <div
      role="status"
      data-testid="mode-banner"
      data-mode={mode}
      style={{
        display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap',
        padding: '4px 12px', background, color: '#fff',
        font: '600 11px/1.6 ui-monospace, SFMono-Regular, Menlo, monospace',
        letterSpacing: '0.04em', borderBottom: '1px solid rgba(255,255,255,.18)',
      }}
    >
      <span
        style={{
          padding: '1px 7px', borderRadius: 3,
          background: 'rgba(255,255,255,.18)', textTransform: 'uppercase',
        }}
      >
        {label}
      </span>
      <span style={{ opacity: 0.9, fontWeight: 400 }}>{detail}</span>
      {real && (
        <span style={{ opacity: 0.75, fontWeight: 400 }}>
          · {unavailableCount()} operations not built on this node — those panels
          are empty or disabled on purpose, never filled with placeholder data
        </span>
      )}
      {offline && (
        <span style={{ opacity: 0.95, fontWeight: 400 }}>
          · showing the last data received; nothing below is live
        </span>
      )}
    </div>
  );
}
