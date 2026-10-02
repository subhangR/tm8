// @vitest-environment jsdom
/**
 * STYLE STORE + `useTheme` SHIM (style design §5, §12 "useTheme-compat").
 *
 * Phase 1's claim is that nothing a viewer can observe moved: the legacy
 * `tm8ui.theme` key still decides, the OS still decides until the viewer
 * chooses, and the hook still speaks `'light' | 'dark'`. What changed is that
 * the tokens now arrive through `<style id="tm8-style-active">`, so the sheet
 * is asserted here too — that it exists before any render, carries the right
 * built-in, and is the ONE sheet however often it is applied.
 */
import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import { ATELIER_DARK, ATELIER_LIGHT } from '@tm8/contract';

import {
  ACTIVE_STYLE_ELEMENT_ID,
  __resetStyleStoreForTests,
  derivedTheme,
  getStyleState,
  installActiveStyle,
} from './style-store';
import { useTheme } from './useTheme';

type MediaListener = () => void;

/** A controllable `prefers-color-scheme: dark` query. */
function stubOs(dark: boolean) {
  const listeners = new Set<MediaListener>();
  const query = {
    get matches() {
      return dark;
    },
    addEventListener: (_: string, cb: MediaListener) => listeners.add(cb),
    removeEventListener: (_: string, cb: MediaListener) => listeners.delete(cb),
  };
  vi.stubGlobal('matchMedia', () => query);
  window.matchMedia = (() => query) as unknown as typeof window.matchMedia;
  return {
    flip(next: boolean) {
      dark = next;
      for (const cb of [...listeners]) cb();
    },
  };
}

const sheet = () => document.getElementById(ACTIVE_STYLE_ELEMENT_ID)?.textContent ?? '';

beforeEach(() => {
  localStorage.clear();
  stubOs(false);
  __resetStyleStoreForTests();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('style store — first paint', () => {
  it('installs one sheet carrying the light built-in when nothing is stored and the OS is light', () => {
    installActiveStyle();
    expect(document.querySelectorAll(`#${ACTIVE_STYLE_ELEMENT_ID}`)).toHaveLength(1);
    expect(sheet()).toContain(`--pn-paper: ${ATELIER_LIGHT.tokens['--pn-paper']};`);
    expect(derivedTheme()).toBe('light');
    expect(getStyleState().followOs).toBe(true);
  });

  it('starts dark from the OS when nothing is stored', () => {
    stubOs(true);
    __resetStyleStoreForTests();
    installActiveStyle();
    expect(derivedTheme()).toBe('dark');
    expect(sheet()).toContain(`--pn-paper: ${ATELIER_DARK.tokens['--pn-paper']};`);
  });

  it('honours the legacy tm8ui.theme key over the OS, and stops following it', () => {
    localStorage.setItem('tm8ui.theme', 'dark');
    __resetStyleStoreForTests();
    expect(derivedTheme()).toBe('dark');
    expect(getStyleState().followOs).toBe(false);
  });

  it('ignores a garbage legacy value rather than trusting it', () => {
    localStorage.setItem('tm8ui.theme', 'sepia');
    __resetStyleStoreForTests();
    expect(derivedTheme()).toBe('light');
    expect(getStyleState().followOs).toBe(true);
  });

  it('re-applying never creates a second sheet', () => {
    installActiveStyle();
    installActiveStyle();
    expect(document.querySelectorAll(`#${ACTIVE_STYLE_ELEMENT_ID}`)).toHaveLength(1);
  });

  it('always carries the dark ramp for always-dark scopes, in light too', () => {
    installActiveStyle();
    const text = sheet();
    const darkRule = text.slice(text.indexOf('[data-always-dark="true"]'));
    expect(darkRule).toContain(`--pn-paper: ${ATELIER_DARK.tokens['--pn-paper']};`);
  });
});

describe('an explicit data-theme that disagrees with the active style keeps its tokens.css ramp', () => {
  /* The review boards (`SettingsBoard`'s `Both`, GalleryPage, FilesNodeBoard)
     stamp light and dark side by side. The sheet's ACTIVE rule may only claim
     roots tokens.css already puts in the active theme; everything else must
     fall through to tokens.css untouched. Asserted with the sheet's REAL
     selector, so a selector edit that re-widens it fails here. */
  const activeSelector = () => sheet().slice(0, sheet().indexOf(' {'));

  function board() {
    document.body.innerHTML = `
      <div class="cv2-root" data-theme="light" id="light"><div class="cv2-root" id="light-nested"></div></div>
      <div class="cv2-root" data-theme="dark" id="dark"><div class="cv2-root" id="dark-nested"></div></div>
      <div class="cv2-root" id="bare"></div>`;
    const el = (id: string) => document.getElementById(id)!;
    return { light: el('light'), lightNested: el('light-nested'), dark: el('dark'), darkNested: el('dark-nested'), bare: el('bare') };
  }

  afterEach(() => {
    document.body.innerHTML = '';
  });

  it('active dark: the dark half takes the style, the light half and a bare root keep tokens.css light', () => {
    localStorage.setItem('tm8ui.theme', 'dark');
    __resetStyleStoreForTests();
    installActiveStyle();
    const b = board();
    const sel = activeSelector();
    expect(b.dark.matches(sel)).toBe(true);
    expect(b.darkNested.matches(sel)).toBe(true);
    expect(b.light.matches(sel)).toBe(false);
    expect(b.lightNested.matches(sel)).toBe(false);
    expect(b.bare.matches(sel)).toBe(false);
  });

  it('active light: the light half and a bare root take the style, the dark half keeps tokens.css dark', () => {
    installActiveStyle();
    const b = board();
    const sel = activeSelector();
    expect(b.light.matches(sel)).toBe(true);
    expect(b.lightNested.matches(sel)).toBe(true);
    expect(b.bare.matches(sel)).toBe(true);
    expect(b.dark.matches(sel)).toBe(false);
    expect(b.darkNested.matches(sel)).toBe(false);
  });
});

describe('useTheme shim — same API, same behaviour', () => {
  it('reports the store theme and the system-default flag', () => {
    const { result } = renderHook(() => useTheme());
    expect(result.current.theme).toBe('light');
    expect(result.current.isSystemDefault).toBe(true);
  });

  it('setTheme applies live, persists the legacy key and stops following the OS', () => {
    installActiveStyle();
    const { result } = renderHook(() => useTheme());
    act(() => result.current.setTheme('dark'));
    expect(result.current.theme).toBe('dark');
    expect(result.current.isSystemDefault).toBe(false);
    expect(localStorage.getItem('tm8ui.theme')).toBe('dark');
    expect(sheet()).toContain(`--pn-paper: ${ATELIER_DARK.tokens['--pn-paper']};`);
  });

  it('toggle flips both ways', () => {
    const { result } = renderHook(() => useTheme());
    act(() => result.current.toggle());
    expect(result.current.theme).toBe('dark');
    act(() => result.current.toggle());
    expect(result.current.theme).toBe('light');
  });

  it('follows the OS until the viewer chooses, then never again', () => {
    const os = stubOs(false);
    __resetStyleStoreForTests();
    const { result } = renderHook(() => useTheme());

    act(() => os.flip(true));
    expect(result.current.theme).toBe('dark');
    expect(result.current.isSystemDefault).toBe(true);

    act(() => result.current.setTheme('light'));
    act(() => os.flip(true));
    expect(result.current.theme).toBe('light');
  });
});

describe('boot wiring', () => {
  /* Read as TEXT, like `mobile-audit-css-parity.test.ts`: importing either entry
     would mount React. The audit harness photographs what production paints, so
     it must install the sheet too, and before its render like main.tsx does. */
  it.each(['../main.tsx', '../mobile-audit-entry.tsx'])('%s installs the sheet before rendering', (file) => {
    const src = readFileSync(new URL(file, import.meta.url), 'utf8');
    const install = src.indexOf('\ninstallActiveStyle();');
    const render = src.indexOf('createRoot(');
    expect(install).toBeGreaterThan(-1);
    expect(render).toBeGreaterThan(install);
  });
});
