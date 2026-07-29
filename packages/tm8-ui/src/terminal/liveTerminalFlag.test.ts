// @vitest-environment jsdom
/**
 * `isLiveTerminalEnabled()` — the gate itself.
 *
 * Mirrors `src/views/realSeamFlag.test.ts` deliberately: the two flags answer
 * the same shape of question (a non-production check + a localStorage
 * opt-in) and share the exact guard-order bug this file's positive control
 * exists to pin, so their tests should look identical rather than drift into
 * two idioms for one concept.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { isLiveTerminalEnabled, resolveLiveTerminalEnabled } from './liveTerminalFlag';

const KEY = 'tm8-ui:live-terminal';

/**
 * This runner's `globalThis.localStorage` is a broken node stub, not
 * jsdom's — measured in the same environment realSeamFlag.test.ts documents.
 * Installing a minimal real Storage keeps the test about this file's logic.
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

describe('isLiveTerminalEnabled — the gate itself', () => {
  beforeEach(installStorage);
  afterEach(() => localStorage.removeItem(KEY));

  it('is OFF by default in the test runner', () => {
    expect(isLiveTerminalEnabled()).toBe(false);
  });

  it('turns ON via the localStorage opt-in', () => {
    localStorage.setItem(KEY, '1');
    expect(isLiveTerminalEnabled()).toBe(true);
  });

  it('treats any value other than "1" as off', () => {
    for (const value of ['0', 'false', 'true', 'yes', '']) {
      localStorage.setItem(KEY, value);
      expect(isLiveTerminalEnabled(), `value ${JSON.stringify(value)}`).toBe(false);
    }
  });

  it('survives a throwing localStorage rather than taking the panel down', () => {
    // THE REGRESSION CONTROL for the guard-order fix (docblock: "GUARD-ORDER
    // FIX"): `typeof localStorage` is a property access, and this getter
    // throws on that access — before `getItem` is ever reached. If the
    // existence check ever moves back outside the `try`, this is the test
    // that catches it: the old code threw straight out of this call.
    const original = Object.getOwnPropertyDescriptor(window, 'localStorage');
    Object.defineProperty(window, 'localStorage', {
      configurable: true,
      get() {
        throw new Error('blocked origin');
      },
    });
    try {
      expect(() => isLiveTerminalEnabled()).not.toThrow();
      expect(isLiveTerminalEnabled()).toBe(false);
    } finally {
      if (original) Object.defineProperty(window, 'localStorage', original);
    }
  });
});

describe('the shipped browser default', () => {
  it('mounts the real terminal in development and production', () => {
    expect(resolveLiveTerminalEnabled({ MODE: 'development' }, null)).toBe(true);
    expect(resolveLiveTerminalEnabled({ MODE: 'production' }, null)).toBe(true);
  });

  it('keeps an explicit operator opt-out', () => {
    expect(resolveLiveTerminalEnabled({ MODE: 'production', VITE_TM8_LIVE_TERMINAL: '0' }, null))
      .toBe(false);
    expect(resolveLiveTerminalEnabled({ MODE: 'production' }, '0')).toBe(false);
  });
});
