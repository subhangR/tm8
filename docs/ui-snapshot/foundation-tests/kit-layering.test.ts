/**
 * DEF-15 — createListKeyNav lives in kit/ (L0); shell/keyboard only
 * re-exports it, so subsystems/collections no longer import upward.
 */
import { describe, expect, it } from 'vitest';
import { createListKeyNav as fromKitBarrel } from '../../kit';
import { createListKeyNav as fromKitModule } from '../../kit/listKeyNav';
import { createListKeyNav as fromShell } from '../../shell/keyboard';

describe('createListKeyNav layering', () => {
  it('shell/keyboard re-exports the exact kit implementation (compat)', () => {
    expect(fromShell).toBe(fromKitModule);
    expect(fromKitBarrel).toBe(fromKitModule);
  });

  it('the kit export behaves (arrow nav smoke)', () => {
    let idx = 0;
    const nav = fromKitModule({ count: 3, index: 0, onIndexChange: (i) => { idx = i; } });
    expect(nav({ key: 'ArrowDown' })).toBe(true);
    expect(idx).toBe(1);
    expect(nav({ key: 'ArrowLeft' })).toBe(false); // vertical list ignores horizontal keys
  });
});
