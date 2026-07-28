// @vitest-environment jsdom
/**
 * The flag-gated seam selection — BOTH halves.
 *
 * A flag test that only exercises the off path proves the default and nothing
 * else: it is satisfied identically by a correct gate and by a gate that can
 * never turn on. So the on path is asserted too, and it is asserted
 * STRUCTURALLY (which seam got constructed) rather than by reaching the
 * network — the point is the selection, and a test that needed a live node to
 * prove a flag would be untestable in CI by construction.
 *
 * Discriminator: `RealSeam` carries `realControls`, the fixture seam carries
 * `fixtureControls`. That is the cheapest honest signal — it is a real
 * interface difference rather than a marker added for the test, so it cannot
 * drift away from the thing it identifies.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import { isRealSeamEnabled } from './realSeamFlag';
import { useGateData } from './useGateData';

const KEY = 'tm8-ui:real-seam';

/**
 * This runner's `globalThis.localStorage` is a BROKEN node stub, not jsdom's:
 * the process warns `--localstorage-file was provided without a valid path`,
 * and the resulting object has no `setItem`/`removeItem`. That shadows jsdom's
 * working implementation, so a flag test would fail for an environment reason
 * having nothing to do with the flag.
 *
 * Installing a minimal real Storage keeps the test about MY logic. Measured
 * rather than assumed: the methods are genuinely absent, which is why this is a
 * substitution and not a convenience mock of something that already worked.
 */
function installStorage(): void {
  const store = new Map<string, string>();
  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    writable: true,
    value: {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => void store.set(k, String(v)),
      removeItem: (k: string) => void store.delete(k),
      clear: () => store.clear(),
      key: (i: number) => [...store.keys()][i] ?? null,
      get length() {
        return store.size;
      },
    },
  });
}

describe('isRealSeamEnabled — the gate itself', () => {
  beforeEach(installStorage);
  afterEach(() => localStorage.removeItem(KEY));

  it('is OFF by default', () => {
    expect(isRealSeamEnabled()).toBe(false);
  });

  it('turns ON via the localStorage opt-in', () => {
    localStorage.setItem(KEY, '1');
    expect(isRealSeamEnabled()).toBe(true);
  });

  it('treats any value other than "1" as off', () => {
    // A flag that accepts "0" or "false" as truthy is a flag nobody can turn
    // off from the console once they have turned it on.
    for (const value of ['0', 'false', 'true', 'yes', '']) {
      localStorage.setItem(KEY, value);
      expect(isRealSeamEnabled(), `value ${JSON.stringify(value)}`).toBe(false);
    }
  });

  it('survives a throwing localStorage rather than taking the shell down', () => {
    const original = Object.getOwnPropertyDescriptor(window, 'localStorage');
    Object.defineProperty(window, 'localStorage', {
      configurable: true,
      get() {
        throw new Error('blocked origin');
      },
    });
    try {
      // A flag that cannot be read is not set — and it must not throw into the
      // one call site that constructs the app's only seam.
      expect(() => isRealSeamEnabled()).not.toThrow();
      expect(isRealSeamEnabled()).toBe(false);
    } finally {
      if (original) Object.defineProperty(window, 'localStorage', original);
    }
  });
});

describe('useGateData constructs the seam the flag selects', () => {
  beforeEach(() => {
    installStorage();
    localStorage.removeItem(KEY);
  });
  afterEach(() => localStorage.removeItem(KEY));

  const opts = { leftKind: 'task', rightKind: 'work_session' };

  it('FLAG OFF → the FIXTURE seam, unchanged from before this flag existed', async () => {
    const { result } = renderHook(() => useGateData(opts));
    await waitFor(() => expect(result.current.ready).toBe(true));
    const seam = result.current.seam as unknown as Record<string, unknown>;
    expect(seam.fixtureControls, 'the fixture seam must be selected by default').toBeDefined();
    expect(seam.realControls).toBeUndefined();
  });

  it('FLAG ON → the REAL seam is constructed, with no network required', () => {
    localStorage.setItem(KEY, '1');
    const { result } = renderHook(() => useGateData(opts));
    // Deliberately NOT waiting for `ready`: the real seam will try to reach a
    // node that does not exist here, and this test is about WHICH SEAM was
    // constructed, not about whether it can talk. Asserting on the ref itself
    // keeps the test honest about its own scope.
    const seam = result.current.seam as unknown as Record<string, unknown>;
    expect(seam.realControls, 'the real seam must be selected when the flag is on').toBeDefined();
    expect(seam.fixtureControls).toBeUndefined();
  });

  it('the flag is read ONCE — flipping it mid-session does not swap the seam', async () => {
    // The contract stated in useGateData: a mid-session swap would leave two
    // event streams feeding one divided cache. Changing the flag requires a
    // reload, and this pins that rather than leaving it to the comment.
    const { result, rerender } = renderHook(() => useGateData(opts));
    await waitFor(() => expect(result.current.ready).toBe(true));
    const before = result.current.seam;

    localStorage.setItem(KEY, '1');
    rerender();

    expect(result.current.seam, 'the seam must be identical across the flip').toBe(before);
    expect(
      (result.current.seam as unknown as Record<string, unknown>).fixtureControls,
    ).toBeDefined();
  });
});
