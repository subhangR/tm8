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
  mode, detail, connected, floating = false,
}: {
  mode: FacadeMode;
  /** Server origin in real mode; the seed name in mock mode. */
  detail: string;
  connected?: boolean;
  /**
   * Render docked to the bottom of the viewport instead of consuming a strip of
   * layout at the top.
   *
   * For the full-bleed workspace, which is a verbatim transplant of maestro's
   * window: an in-flow banner pushed the whole application down ~29px, so the
   * project tab bar started at y=29 where the reference has it at y=0. Every
   * pixel comparison below it inherited that offset.
   *
   * NOT removed on that route, and the distinction matters — this component's
   * whole purpose is that a viewer can always classify what they are looking
   * at, and "the screen where we hid the honesty banner" is the exact screen
   * most likely to be mistaken for the real maestro. So it keeps saying the
   * same thing in the same words; it just stops displacing the app to do it.
   */
  floating?: boolean;
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
      data-floating={floating || undefined}
      style={{
        display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap',
        padding: '4px 12px', background, color: '#fff',
        font: '600 11px/1.6 ui-monospace, SFMono-Regular, Menlo, monospace',
        letterSpacing: '0.04em',
        ...(floating
          // Bottom rather than top: the top strip is where the transplanted
          // project tab bar lives, and covering that would trade a layout
          // offset for an occlusion — the same pixel problem wearing a hat.
          //
          // TWO SEPARATE FIXES HERE, and shipping only the first would have
          // been the worse outcome. A full-width fixed strip INTERCEPTED
          // POINTER EVENTS on the composer's Terminate button underneath it —
          // a live control a user could see and not press.
          //
          //  - `pointerEvents: 'none'` makes it click-through. Safe without
          //    qualification: this component renders only <span>s, so there is
          //    nothing in it to click and nothing is lost by opting out.
          //  - but click-through alone only fixes the ROBOT. A user still
          //    could not SEE the button under an opaque bar. So it is no
          //    longer a full-width strip: it shrinks to its content and sits
          //    bottom-LEFT, over the task list's empty tail rather than over
          //    the centre pane's action row.
          //
          // Fixing only the interception would have turned a visible blocker
          // into an invisible one and let the drive go green over a control
          // the user cannot find.
          ? {
              position: 'fixed' as const, bottom: 0, left: 0, zIndex: 90,
              maxWidth: 'min(100%, 720px)',
              pointerEvents: 'none' as const,
              borderTop: '1px solid rgba(255,255,255,.18)',
              borderRight: '1px solid rgba(255,255,255,.18)',
              borderTopRightRadius: 6,
            }
          : { borderBottom: '1px solid rgba(255,255,255,.18)' }),
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
