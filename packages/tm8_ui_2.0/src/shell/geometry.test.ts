/**
 * LLD §15.4 — panel-engine unit tests: the C_min table, admission refusal
 * reasons, demotion-loop convergence (including the empty-stack V-constant
 * step and the sub-320 stop state), and the shrink order.
 *
 * These are LOGIC tests. jsdom has no layout engine, so nothing here claims a
 * pixel: every width is an argument, never a measurement. Pixel acceptance is
 * the D10 real-browser pass at the R5 gate.
 */
import { describe, expect, it } from 'vitest';
import type { EntityId } from '@tm8/contract';
import {
  GRID_GAP,
  LEFT_PANEL_DEFAULT,
  LEFT_PANEL_MIN,
  MAX_PINNED,
  MENU_COLLAPSED,
  MENU_EXPANDED,
  PANEL_COL_MIN,
  RIGHT_PANEL_DEFAULT,
  RIGHT_PANEL_MIN,
  admitPin,
  cMin,
  cMinFor,
  normalize,
  panelSlots,
  solveWorkspace,
} from './geometry';

const id = (n: number): EntityId => `ent_${n}` as EntityId;
const ids = (n: number): EntityId[] => Array.from({ length: n }, (_, i) => id(i + 1));

describe('C_min — the law (LLD §5.1, WLT §6)', () => {
  it('reproduces the LLD table exactly', () => {
    expect([0, 1, 2, 3, 4].map(cMin)).toEqual([320, 320, 648, 976, 1304]);
  });

  it('agrees with the closed form V·320 + (V−1)·8 for every V ≥ 1', () => {
    for (let v = 1; v <= 12; v++) {
      expect(cMin(v)).toBe(v * PANEL_COL_MIN + (v - 1) * GRID_GAP);
    }
  });

  it('floors V=0 at one panel column — an empty center never collapses', () => {
    // 02-LAYOUT §2.2: the empty center still hosts the live-session roster.
    expect(cMin(0)).toBe(PANEL_COL_MIN);
    expect(cMin(0)).toBe(cMin(1));
  });

  it('counts the whole stack as ONE slot and each pin as its own', () => {
    expect(panelSlots({ stack: [], pinned: [] })).toBe(0);
    expect(panelSlots({ stack: ids(7), pinned: [] })).toBe(1);
    expect(panelSlots({ stack: [], pinned: ids(3) })).toBe(3);
    expect(panelSlots({ stack: ids(4), pinned: ids(2) })).toBe(3);
  });

  it('is monotonic in V — adding a panel never lowers the floor', () => {
    for (let v = 0; v < 12; v++) expect(cMin(v + 1)).toBeGreaterThanOrEqual(cMin(v));
  });
});

describe('admission (LLD §5.3)', () => {
  const wide = 4000;

  it('admits a pin when the center clears the post-admission floor', () => {
    expect(admitPin({ stack: [id(1)], pinned: [], id: id(1), centerWidth: wide })).toEqual({
      admitted: true,
    });
  });

  it('refuses the 4th pin with the max-pins reason, naming the number', () => {
    const refusal = admitPin({ stack: [id(9)], pinned: ids(3), id: id(9), centerWidth: wide });
    expect(refusal.admitted).toBe(false);
    if (refusal.admitted) throw new Error('unreachable');
    expect(refusal.reason).toBe('max-pins');
    expect(refusal.cause).toBe("Can't pin — 3 panels pinned");
    expect(refusal.remedy).toBe('unpin one first · max 3 (02 §2.1)');
  });

  it('refuses a too-narrow center and quotes BOTH the requirement and the measurement', () => {
    // Pinning the 3rd of three panels while a stack entry remains ⇒ V′ = 4 ⇒ 1304.
    const refusal = admitPin({
      stack: [id(8), id(9)],
      pinned: [id(1), id(2)],
      id: id(9),
      centerWidth: 730,
    });
    expect(refusal.admitted).toBe(false);
    if (refusal.admitted) throw new Error('unreachable');
    expect(refusal.reason).toBe('narrow');
    expect(refusal.cause).toBe("Can't pin — center too narrow");
    // T1-4's binding voice rule: reasons name numbers so they read as fact.
    expect(refusal.remedy).toBe('needs 1304px for 4 columns · now 730');
  });

  it('the T1-4 canvas refusal string is reproducible from the real formula', () => {
    // The canvas draws "needs 976px for 3 columns · now 730". 976 === C_min(3).
    const refusal = admitPin({
      stack: [id(8)],
      pinned: [id(1), id(2)],
      id: id(8),
      centerWidth: 730,
    });
    if (refusal.admitted) throw new Error('expected refusal');
    expect(refusal.remedy).toBe('needs 976px for 3 columns · now 730');
  });

  it('pinning the ONLY stack entry is geometrically free — V′ === V, not V+1', () => {
    // The stack loses its slot as the pin gains one, so the floor does not move.
    const before = cMinFor({ stack: [id(1)], pinned: [id(2)] }); // V=2 ⇒ 648
    expect(before).toBe(648);
    expect(admitPin({ stack: [id(1)], pinned: [id(2)], id: id(1), centerWidth: 648 })).toEqual({
      admitted: true,
    });
  });

  it('pinning one of SEVERAL stack entries costs a slot — the stack keeps its own', () => {
    expect(
      admitPin({ stack: [id(1), id(3)], pinned: [id(2)], id: id(1), centerWidth: 648 }).admitted,
    ).toBe(false);
    expect(
      admitPin({ stack: [id(1), id(3)], pinned: [id(2)], id: id(1), centerWidth: 976 }).admitted,
    ).toBe(true);
  });

  it('max-pins outranks narrowness — one refusal, the most actionable one', () => {
    const refusal = admitPin({ stack: [id(9)], pinned: ids(3), id: id(9), centerWidth: 10 });
    if (refusal.admitted) throw new Error('expected refusal');
    expect(refusal.reason).toBe('max-pins');
  });

  describe('the pool lease clause (§9.2)', () => {
    it('refuses when admitting would exceed k−1 leases', () => {
      const refusal = admitPin({
        stack: [id(1)],
        pinned: [],
        id: id(1),
        centerWidth: wide,
        pool: { activeLeases: 4, capacity: 5, candidateTakesLease: true },
      });
      if (refusal.admitted) throw new Error('expected refusal');
      expect(refusal.reason).toBe('pool-capacity');
      expect(refusal.remedy).toBe('4 of 4 terminal slots in use · close one first');
    });

    it('does not apply to a candidate that takes no lease', () => {
      expect(
        admitPin({
          stack: [id(1)],
          pinned: [],
          id: id(1),
          centerWidth: wide,
          pool: { activeLeases: 4, capacity: 5, candidateTakesLease: false },
        }).admitted,
      ).toBe(true);
    });

    it('is NOT evaluated when the caller supplies no pool facts', () => {
      // Documented gap, not a silent pass: the terminal lane wires `pool`.
      expect(admitPin({ stack: [id(1)], pinned: [], id: id(1), centerWidth: wide }).admitted).toBe(
        true,
      );
    });
  });
});

describe('normalization — the demotion loop (LLD §5.3)', () => {
  it('does nothing when the center already clears the floor', () => {
    const result = normalize({ stack: [id(9)], pinned: ids(2), centerWidth: 4000 });
    expect(result.pinned).toEqual(ids(2));
    expect(result.demoted).toEqual([]);
    expect(result.exhausted).toBe(false);
  });

  it('demotes the OLDEST pin, and lands it on the stack TOP (array end, `p` is bottom→top)', () => {
    const result = normalize({ stack: [id(9)], pinned: [id(1), id(2)], centerWidth: 700 });
    expect(result.cause).toBe('width');
    expect(result.demoted).toEqual([id(1)]);
    expect(result.pinned).toEqual([id(2)]);
    expect(result.stack).toEqual([id(9), id(1)]);
  });

  it('IS A LOOP, NOT A STEP: demoting onto an empty stack keeps V constant', () => {
    // pinned=2, stack=[] ⇒ V=2 ⇒ needs 648. At 500 we must demote.
    // First demotion: pinned 2→1, stack 0→1 ⇒ V still 2. NO progress.
    // A single-step implementation would stop here, still violating the floor.
    const result = normalize({ stack: [], pinned: [id(1), id(2)], centerWidth: 500 });
    expect(result.demoted).toEqual([id(1), id(2)]);
    expect(result.pinned).toEqual([]);
    expect(result.stack).toEqual([id(1), id(2)]);
    // Converged: V=1 ⇒ 320 ≤ 500.
    expect(cMinFor(result)).toBe(320);
    expect(result.exhausted).toBe(false);
  });

  it('converges from 3 pins + empty stack — the named acceptance case', () => {
    const result = normalize({ stack: [], pinned: ids(3), centerWidth: 400 });
    expect(result.demoted).toEqual(ids(3));
    expect(result.pinned).toEqual([]);
    expect(result.stack).toEqual(ids(3));
    expect(result.exhausted).toBe(false);
    expect(400).toBeGreaterThanOrEqual(cMinFor(result));
  });

  it('demotes only as far as it must — it does not empty the pins gratuitously', () => {
    // 976 clears V=3 exactly; nothing should move.
    expect(normalize({ stack: [], pinned: ids(3), centerWidth: 976 }).demoted).toEqual([]);

    // One pixel less takes TWO demotions, not one — and that is the law, not a
    // bug. From (3 pins, empty stack) the first demotion is V-constant: pinned
    // 3→2 while the stack gains its first slot, so V stays 3 and 976 is still
    // required. Only the second demotion moves V to 2. This case is precisely
    // why §5.3 specifies a loop; a single-step engine would settle here still
    // violating its own floor.
    const tight = normalize({ stack: [], pinned: ids(3), centerWidth: 975 });
    expect(tight.demoted).toEqual([id(1), id(2)]);
    expect(tight.pinned).toEqual([id(3)]);
    expect(cMinFor(tight)).toBe(648);

    // With a non-empty stack the first demotion is NOT V-constant (the stack
    // already holds its slot), so one demotion is enough — but note the floor
    // it starts from is C_min(4)=1304, not 976: 3 pins PLUS a stack is four
    // columns. At 1000 exactly one pin goes and V settles at 3.
    const seeded = normalize({ stack: [id(9)], pinned: ids(3), centerWidth: 1000 });
    expect(seeded.demoted).toEqual([id(1)]);
    expect(seeded.pinned).toEqual([id(2), id(3)]);
    expect(cMinFor(seeded)).toBe(976);
  });

  it('enforces MAX_PINNED even in a limitless center (hydration can deliver >3)', () => {
    const result = normalize({ stack: [], pinned: ids(5), centerWidth: 100_000 });
    expect(result.cause).toBe('max-pins');
    expect(result.pinned).toEqual([id(3), id(4), id(5)]);
    expect(result.demoted).toEqual([id(1), id(2)]);
    expect(result.pinned.length).toBe(MAX_PINNED);
  });

  it('reports both when width and the authored pin cap drive the settle', () => {
    const result = normalize({ stack: [id(9)], pinned: ids(5), centerWidth: 500 });
    expect(result.cause).toBe('both');
  });

  it('C-3 EXIT STATE: pins exhausted and still under 320 ⇒ stop, never empty the stack', () => {
    const result = normalize({ stack: [id(9)], pinned: [id(1)], centerWidth: 200 });
    expect(result.exhausted).toBe(true);
    expect(result.pinned).toEqual([]);
    // The stack still holds both — normalization refuses to dismantle it.
    expect(result.stack).toEqual([id(9), id(1)]);
    expect(result.stack.length).toBeGreaterThan(0);
  });

  it('C-3 exit state is reached with no pins at all, without looping forever', () => {
    const result = normalize({ stack: [id(9)], pinned: [], centerWidth: 10 });
    expect(result.exhausted).toBe(true);
    expect(result.demoted).toEqual([]);
    expect(result.stack).toEqual([id(9)]);
  });

  it('terminates for every (pins, stack, width) combination in a swept matrix', () => {
    for (let pins = 0; pins <= 6; pins++) {
      for (let stackSize = 0; stackSize <= 3; stackSize++) {
        for (const width of [0, 1, 319, 320, 500, 648, 976, 1304, 5000]) {
          const result = normalize({
            stack: ids(stackSize).map((e) => `s${e}` as EntityId),
            pinned: ids(pins),
            centerWidth: width,
          });
          // Convergence contract: either the constraint holds, or we stopped
          // in the honest exit state with nothing left to demote.
          const satisfied = width >= cMinFor(result) && result.pinned.length <= MAX_PINNED;
          expect(satisfied || (result.exhausted && result.pinned.length === 0)).toBe(true);
          // Demotions are conserved: nothing is invented or lost.
          expect(result.pinned.length + result.stack.length).toBe(pins + stackSize);
        }
      }
    }
  });

  it('is idempotent — re-running a settled state changes nothing', () => {
    const once = normalize({ stack: [], pinned: ids(3), centerWidth: 500 });
    const twice = normalize({ stack: once.stack, pinned: once.pinned, centerWidth: 500 });
    expect(twice.stack).toEqual(once.stack);
    expect(twice.pinned).toEqual(once.pinned);
    expect(twice.demoted).toEqual([]);
  });

  it('widening never auto-restores demoted pins (§5.3)', () => {
    const narrow = normalize({ stack: [], pinned: ids(3), centerWidth: 400 });
    const widened = normalize({ stack: narrow.stack, pinned: narrow.pinned, centerWidth: 4000 });
    expect(widened.pinned).toEqual([]);
    expect(widened.stack).toEqual(ids(3));
  });

  it('does not mutate its inputs', () => {
    const stack = [id(9)];
    const pinned = ids(3);
    normalize({ stack, pinned, centerWidth: 100 });
    expect(stack).toEqual([id(9)]);
    expect(pinned).toEqual(ids(3));
  });
});

describe('shrink order (02-LAYOUT §5 / WLT §6 / T1-3)', () => {
  const base = { serverRail: false, stack: [id(9)], pinned: [] as EntityId[] };

  it('keeps the menu expanded and both panels at their defaults when there is room', () => {
    const layout = solveWorkspace({ ...base, viewport: 1920 });
    expect(layout.menu).toBe(MENU_EXPANDED);
    expect(layout.stackMode).toBe('columns');
    expect(layout.left).toBe(LEFT_PANEL_DEFAULT);
    expect(layout.right).toBe(319);
    expect(layout.center).toBeGreaterThanOrEqual(layout.centerMin);
  });

  it('STEP 1 — the menu collapses before a side panel gives up a pixel', () => {
    // Chosen so the layout fits at M=48 but not at M=220.
    const wide = solveWorkspace({ ...base, viewport: 1920, pinned: ids(3), stack: [] });
    const tight = solveWorkspace({ ...base, viewport: 1700, pinned: ids(3), stack: [] });
    expect(wide.menu).toBe(MENU_EXPANDED);
    expect(tight.menu).toBe(MENU_COLLAPSED);
    // …and the panels are still untouched at their defaults.
    expect(tight.left).toBe(LEFT_PANEL_DEFAULT);
    expect(tight.right).toBe(RIGHT_PANEL_DEFAULT);
    expect(tight.stackMode).toBe('columns');
  });

  it('STEP 2 — side panels shrink toward their floors, never below', () => {
    const layout = solveWorkspace({ ...base, viewport: 1550, pinned: ids(3), stack: [] });
    expect(layout.menu).toBe(MENU_COLLAPSED);
    expect(layout.left).toBeGreaterThanOrEqual(LEFT_PANEL_MIN);
    expect(layout.right).toBeGreaterThanOrEqual(RIGHT_PANEL_MIN);
    expect(layout.left).toBeLessThan(LEFT_PANEL_DEFAULT);
  });

  it('never returns a side panel below its floor at ANY viewport', () => {
    for (let viewport = 200; viewport <= 2600; viewport += 7) {
      const layout = solveWorkspace({ ...base, viewport, pinned: ids(2) });
      // A stacked panel is 0 (it is not a column at all); a column honors L4.
      if (layout.left > 0) expect(layout.left).toBeGreaterThanOrEqual(LEFT_PANEL_MIN);
      if (layout.right > 0) expect(layout.right).toBeGreaterThanOrEqual(RIGHT_PANEL_MIN);
      expect(layout.menu === MENU_COLLAPSED || layout.menu === MENU_EXPANDED).toBe(true);
    }
  });

  it('STEPS 4/5 — panels stack right, then both, then sheets, in that order', () => {
    const seen: string[] = [];
    for (let viewport = 2000; viewport >= 200; viewport -= 1) {
      const mode = solveWorkspace({ ...base, viewport, pinned: [] }).stackMode;
      if (seen[seen.length - 1] !== mode) seen.push(mode);
    }
    // The order is what is asserted — NOT the pixel each transition happens at.
    // Those constants are DERIVED at reference capture (WLT §6), not here.
    expect(seen).toEqual(['columns', 'right-stacked', 'both-stacked', 'sheets']);
  });

  it('the stack mode only ever degrades as the viewport narrows (no oscillation)', () => {
    const rank = { columns: 0, 'right-stacked': 1, 'both-stacked': 2, sheets: 3 } as const;
    let previous = -1;
    for (let viewport = 2400; viewport >= 200; viewport -= 3) {
      const mode = solveWorkspace({ ...base, viewport, pinned: ids(2) }).stackMode;
      expect(rank[mode]).toBeGreaterThanOrEqual(previous);
      previous = rank[mode];
    }
  });

  it('forces the menu to 48 by the time panels stack (WLT: both-stacked = S + 48 + C_min)', () => {
    for (let viewport = 200; viewport <= 1400; viewport += 11) {
      const layout = solveWorkspace({ ...base, viewport, pinned: ids(2) });
      if (layout.stackMode !== 'columns') expect(layout.menu).toBe(MENU_COLLAPSED);
    }
  });

  it('a hand-collapsed rail is never re-expanded underneath the viewer', () => {
    const layout = solveWorkspace({ ...base, viewport: 3000, menuCollapsedByUser: true });
    expect(layout.menu).toBe(MENU_COLLAPSED);
    expect(layout.stackMode).toBe('columns');
  });

  it('admits the honest overflow state rather than faking a sub-floor panel', () => {
    const layout = solveWorkspace({ ...base, viewport: 300 });
    expect(layout.stackMode).toBe('sheets');
    expect(layout.belowFloors).toBe(true);
  });

  it('spends a gap only on a side panel that is actually a column', () => {
    const columns = solveWorkspace({ ...base, viewport: 1920 });
    expect(columns.center).toBe(1920 - MENU_EXPANDED - columns.left - columns.right - 2 * GRID_GAP);

    const both = solveWorkspace({ ...base, viewport: 420, pinned: [] });
    expect(both.left).toBe(0);
    expect(both.right).toBe(0);
    expect(both.center).toBe(420 - MENU_COLLAPSED); // zero gaps spent
  });

  it('accounts for the server rail when it is shown (R10: hidden in Phase 1)', () => {
    const hidden = solveWorkspace({ ...base, viewport: 1920, serverRail: false });
    const shown = solveWorkspace({ ...base, viewport: 1920, serverRail: true });
    expect(shown.serverRail).toBe(48);
    expect(hidden.serverRail).toBe(0);
    expect(hidden.center - shown.center).toBe(48);
  });

  it('subtracts the measured Σb chrome budget when the caller supplies one', () => {
    const bare = solveWorkspace({ ...base, viewport: 1920 });
    const measured = solveWorkspace({ ...base, viewport: 1920, borders: 17 });
    expect(bare.center - measured.center).toBe(17);
  });

  it('raises the center floor as pins are added — the two engines agree', () => {
    for (let pins = 0; pins <= 3; pins++) {
      const layout = solveWorkspace({ ...base, viewport: 2560, pinned: ids(pins) });
      expect(layout.centerMin).toBe(cMinFor({ stack: base.stack, pinned: ids(pins) }));
    }
  });

  it('hands a center to `normalize` that the loop then settles (the real pipeline)', () => {
    // Solve tracks → measure center → normalize against it. This is the order
    // §5.3 mandates: demotion reacts to a measurement, it does not predict one.
    // 1000px: even with the rail collapsed, both panels stacked and the center
    // taking the full width, 952px cannot host 3 pinned columns (976).
    const state = { stack: [] as EntityId[], pinned: ids(3) };
    const layout = solveWorkspace({ ...base, ...state, viewport: 1000 });
    expect(layout.center).toBeLessThan(layout.centerMin);

    const settled = normalize({ ...state, centerWidth: layout.center });
    expect(settled.demoted).toEqual([id(1), id(2)]);

    // Re-solving with the settled state clears the floor — the pipeline closes.
    const resolved = solveWorkspace({ ...base, ...settled, viewport: 1000 });
    expect(resolved.center).toBeGreaterThanOrEqual(resolved.centerMin);
  });
});
