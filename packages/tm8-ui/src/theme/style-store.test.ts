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
import { createElement } from 'react';
import { act, render, renderHook } from '@testing-library/react';
import { CHATGPT_DARK, CHATGPT_LIGHT } from '@tm8/contract';

import {
  ACTIVE_STYLE_ELEMENT_ID,
  EXTRA_STYLE_ELEMENT_ID,
  STYLE_CACHE_KEY,
  __resetStyleStoreForTests,
  derivedTheme,
  getStyleState,
  installActiveStyle,
  selectStyle,
  subscribeStyle,
} from './style-store';
import { useTheme } from './useTheme';
import { AlwaysDark } from '../terminal/AlwaysDark';

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
    expect(sheet()).toContain(`--pn-paper: ${CHATGPT_LIGHT.tokens['--pn-paper']};`);
    expect(derivedTheme()).toBe('light');
    expect(getStyleState().followOs).toBe(true);
  });

  it('starts dark from the OS when nothing is stored', () => {
    stubOs(true);
    __resetStyleStoreForTests();
    installActiveStyle();
    expect(derivedTheme()).toBe('dark');
    expect(sheet()).toContain(`--pn-paper: ${CHATGPT_DARK.tokens['--pn-paper']};`);
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
    expect(darkRule).toContain(`--pn-paper: ${CHATGPT_DARK.tokens['--pn-paper']};`);
  });
});

describe('theme-color follows the painted style (audit E2)', () => {
  const metas = () => Array.from(document.head.querySelectorAll<HTMLMetaElement>('meta[name="theme-color"]'));

  beforeEach(() => {
    for (const m of metas()) m.remove();
    /* What index.html ships: a light tag and an OS-dark tag. */
    document.head.insertAdjacentHTML(
      'beforeend',
      '<meta name="theme-color" content="#FBFAF6"><meta name="theme-color" media="(prefers-color-scheme: dark)" content="#0A0A0A">',
    );
  });

  it('collapses the first-paint pair to one tag carrying the light surface', () => {
    installActiveStyle();
    expect(metas()).toHaveLength(1);
    expect(metas()[0]!.hasAttribute('media')).toBe(false);
    expect(metas()[0]!.content).toBe(CHATGPT_LIGHT.tokens['--pn-surface']);
  });

  it('turns dark when the viewer chooses dark on a light OS, and back', () => {
    installActiveStyle();
    act(() => {
      selectStyle('builtin:chatgpt-dark');
    });
    expect(metas()).toHaveLength(1);
    expect(metas()[0]!.content).toBe(CHATGPT_DARK.tokens['--pn-surface']);
    act(() => {
      selectStyle('builtin:chatgpt-light');
    });
    expect(metas()[0]!.content).toBe(CHATGPT_LIGHT.tokens['--pn-surface']);
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

describe('selectStyle — the "use" operation (spec §1.4)', () => {
  const uuid = '01a0fc78-3974-73cc-9425-c8741062c673';
  const extra = () => document.getElementById(EXTRA_STYLE_ELEMENT_ID)?.textContent ?? null;
  const personal = {
    schemaVersion: 1 as const,
    foundation: 'builtin:chatgpt-dark' as const,
    vars: { '--pn-paper': '#101820' },
    css: '.pn-chip { color: red; position: fixed }',
  };

  it('uses a built-in by ref, live, and stops following the OS', () => {
    installActiveStyle();
    const seen: string[] = [];
    subscribeStyle((st) => seen.push(st.ref));
    expect(selectStyle('builtin:chatgpt-dark')).toBe(true);
    expect(getStyleState().ref).toBe('builtin:chatgpt-dark');
    expect(getStyleState().followOs).toBe(false);
    expect(derivedTheme()).toBe('dark');
    expect(seen).toEqual(['builtin:chatgpt-dark']);
  });

  it('reads a retired Atelier ref as the ChatGPT built-in of the same mode', () => {
    expect(selectStyle('builtin:atelier-dark')).toBe(true);
    expect(getStyleState().ref).toBe('builtin:chatgpt-dark');
    expect(selectStyle('builtin:atelier-light')).toBe(true);
    expect(getStyleState().ref).toBe('builtin:chatgpt-light');
  });

  it('paints an old cache holding Atelier as ChatGPT on the first frame', () => {
    localStorage.setItem(
      STYLE_CACHE_KEY,
      JSON.stringify({
        docs: {
          current: { ref: 'builtin:atelier-dark', doc: { schemaVersion: 1, foundation: 'builtin:atelier-dark', vars: {}, css: null } },
          dark: null,
        },
        hash: 'stale',
        followOs: false,
        revision: 0,
        source: 'local',
      }),
    );
    __resetStyleStoreForTests();
    installActiveStyle();
    expect(getStyleState().ref).toBe('builtin:chatgpt-dark');
    expect(sheet()).toContain(`--pn-paper: ${CHATGPT_DARK.tokens['--pn-paper']};`);
  });

  it('uses a personal style from its document and runs its sanitized css', () => {
    installActiveStyle();
    expect(selectStyle(`personal:${uuid}`, personal)).toBe(true);
    expect(sheet()).toContain('--pn-paper: #101820;');
    expect(extra()).toBe('.cv2-root .pn-chip {\n  color: red;\n}\n');
    /* The css sheet comes after the vars sheet, so a style's rules are never
       out-ordered by its own variables. */
    const ids = [...document.head.querySelectorAll('style')].map((e) => e.id);
    expect(ids.indexOf(EXTRA_STYLE_ELEMENT_ID)).toBeGreaterThan(ids.indexOf(ACTIVE_STYLE_ELEMENT_ID));
  });

  it('does not run a space style\'s css unless the viewer opted in', () => {
    installActiveStyle();
    selectStyle(`space:${uuid}`, personal);
    expect(sheet()).toContain('--pn-paper: #101820;');
    expect(extra()).toBeNull();
    selectStyle(`space:${uuid}`, personal, { trustCss: true });
    expect(extra()).not.toBeNull();
  });

  it('removes the css sheet when the next style has none', () => {
    installActiveStyle();
    selectStyle(`personal:${uuid}`, personal);
    selectStyle('builtin:chatgpt-light');
    expect(extra()).toBeNull();
  });

  it('changes nothing for a malformed ref, an unknown built-in, or a user style without its document', () => {
    installActiveStyle();
    const before = getStyleState();
    expect(selectStyle('nonsense' as never)).toBe(false);
    expect(selectStyle('builtin:nope')).toBe(false);
    expect(selectStyle(`personal:${uuid}`)).toBe(false);
    expect(getStyleState()).toBe(before);
  });
});

describe('always-dark scopes follow --pn-term-chrome', () => {
  const uuid = '01a0fc78-3974-73cc-9425-c8741062c673';
  const followDoc = (foundation: 'builtin:chatgpt-light' | 'builtin:chatgpt-dark') => ({
    schemaVersion: 1 as const,
    foundation,
    vars: { '--pn-term-chrome': 'follow' },
    css: null,
  });
  const scope = () => {
    const { container } = render(createElement(AlwaysDark, null, createElement('span', null, 'term')));
    return container.querySelector('[data-always-dark="true"]')!;
  };
  const mainSelector = () => sheet().slice(0, sheet().indexOf(' {'));

  it('chrome dark (every built-in): the scope is stamped dark and painted by the always-dark rule — unchanged', () => {
    installActiveStyle();
    const el = scope();
    expect(el.getAttribute('data-theme')).toBe('dark');
    expect(el.matches(mainSelector())).toBe(false);
    expect(sheet()).toContain('[data-always-dark="true"] .cv2-root {');
  });

  it('chrome follow under a light style: no dark stamp, the light rule reaches the scope, no always-dark rule', () => {
    installActiveStyle();
    act(() => {
      selectStyle(`personal:${uuid}`, followDoc('builtin:chatgpt-light'));
    });
    const el = scope();
    expect(el.hasAttribute('data-theme')).toBe(false);
    expect(el.matches(mainSelector())).toBe(true);
    expect(sheet()).not.toContain('data-always-dark');
  });

  it('chrome follow under a dark style: stamped dark by the style, painted by the dark rule', () => {
    installActiveStyle();
    act(() => {
      selectStyle(`personal:${uuid}`, followDoc('builtin:chatgpt-dark'));
    });
    const el = scope();
    expect(el.getAttribute('data-theme')).toBe('dark');
    expect(el.matches(mainSelector())).toBe(true);
  });

  it('re-stamps live when the style changes under a mounted scope', () => {
    installActiveStyle();
    const el = scope();
    expect(el.getAttribute('data-theme')).toBe('dark');
    act(() => {
      selectStyle(`personal:${uuid}`, followDoc('builtin:chatgpt-light'));
    });
    expect(el.hasAttribute('data-theme')).toBe(false);
    act(() => {
      selectStyle('builtin:chatgpt-light');
    });
    expect(el.getAttribute('data-theme')).toBe('dark');
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
    expect(sheet()).toContain(`--pn-paper: ${CHATGPT_DARK.tokens['--pn-paper']};`);
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
