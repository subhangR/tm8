// @vitest-environment jsdom
/**
 * Phase 4 (spec v8 §9.1, §9.2): the kind widgets, the composite views, the
 * picker's hover preview and its upstream badge.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createElement } from 'react';
import { act, fireEvent, render, renderHook, screen, within } from '@testing-library/react';
import {
  STYLE_REGISTRY,
  concreteStyleTable,
  registryByKey,
  resolveStyle,
  styleContrastChecks,
  styleDocForBuiltin,
  validateStyleVar,
  type PersonalStyleSummary,
  type PersonalStyleView,
  type StyleDoc,
  type StyleGetResult,
} from '@tm8/contract';

import { __resetStyleStoreForTests, flushStyleDraft, getStyleState, hasDraft } from './style-store';
import { StyleEditor } from './StyleEditor';
import { HOVER_PREVIEW_MS, StylePicker, useHoverPreview } from './StylePicker';
import { formatRgba, parseRgba, stepFor, stepperNumber } from './style-widgets';

const BY_KEY = registryByKey(STYLE_REGISTRY);
const COLOUR_KEYS = new Set(STYLE_REGISTRY.entries.filter((e) => e.kind === 'colour').map((e) => e.key as string));
const valid = (key: string, value: string) => validateStyleVar(BY_KEY.get(key)!, value, COLOUR_KEYS).ok;

function personal(doc: StyleDoc, extra: Partial<PersonalStyleView> = {}): StyleGetResult {
  const view: PersonalStyleView = {
    id: 'p1',
    ref: 'personal:p1',
    title: 'Mine',
    description: null,
    tags: [],
    version: 1,
    doc,
    resolvedHash: null,
    publishedAs: null,
    publishedVersion: null,
    pulledFrom: null,
    createdAt: '2026-10-02T00:00:00Z',
    updatedAt: '2026-10-02T00:00:00Z',
    ...extra,
  };
  return {
    origin: 'personal',
    ref: view.ref,
    id: view.id,
    title: view.title,
    description: null,
    tags: [],
    version: view.version,
    doc,
    resolvedHash: null,
    resolved: resolveStyle(doc),
    warnings: [],
    personal: view,
  };
}

async function openEditor(doc: StyleDoc = styleDocForBuiltin('builtin:atelier-light')) {
  const got = personal(doc);
  render(
    createElement(StyleEditor, {
      seam: { style: async () => got },
      target: { kind: 'personal', id: 'p1' },
      spaceId: null,
      members: [],
      onClose: () => {},
    }),
  );
  await screen.findByDisplayValue('Mine');
}

async function tab(name: string) {
  await act(async () => {
    fireEvent.click(screen.getByRole('tab', { name }));
  });
}

beforeEach(() => {
  localStorage.clear();
  __resetStyleStoreForTests();
});

describe('colour and number helpers', () => {
  it('parses and formats the colour forms the built-ins use', () => {
    expect(parseRgba('#B26A2B')).toEqual({ r: 178, g: 106, b: 43, a: 1 });
    expect(parseRgba('rgba(178, 106, 43, 0.11)')).toEqual({ r: 178, g: 106, b: 43, a: 0.11 });
    expect(parseRgba('rgb(1 2 3 / 50%)')).toEqual({ r: 1, g: 2, b: 3, a: 0.5 });
    expect(parseRgba('oklch(0.5 0.1 20)')).toBeNull();
    expect(formatRgba({ r: 178, g: 106, b: 43, a: 1 })).toBe('#b26a2b');
    expect(formatRgba({ r: 178, g: 106, b: 43, a: 0.25 })).toBe('rgba(178, 106, 43, 0.25)');
    expect(valid('--pn-brand-soft', formatRgba({ r: 1, g: 2, b: 3, a: 0.4 }))).toBe(true);
  });

  it('steps by unit and range, and reads only values in the written unit', () => {
    expect(stepFor(BY_KEY.get('--pn-fs-body')!)).toBe(1);
    expect(stepFor(BY_KEY.get('--pn-track-label')!)).toBe(0.01);
    expect(stepFor(BY_KEY.get('--pn-dur-base')!)).toBe(10);
    expect(stepFor(BY_KEY.get('--pn-lh-body')!)).toBe(0.05);
    expect(stepFor(BY_KEY.get('--pn-term-scrollback')!)).toBe(500);
    expect(stepFor(BY_KEY.get('--pn-term-font-weight')!)).toBe(100);
    expect(stepperNumber(BY_KEY.get('--pn-fs-body')!, '14px')).toBe(14);
    expect(stepperNumber(BY_KEY.get('--pn-fs-body')!, '1rem')).toBeNull();
    expect(stepperNumber(BY_KEY.get('--pn-term-padding')!, '4')).toBe(4);
    expect(stepperNumber(BY_KEY.get('--pn-dur-base')!, '180ms')).toBe(180);
  });
});

describe('styleContrastChecks is what the lint warns from', () => {
  it('every failing check is a low-contrast warning and nothing else is', () => {
    const doc: StyleDoc = { ...styleDocForBuiltin('builtin:atelier-light'), vars: { '--pn-ink': '#EEEEEE' } };
    const resolved = resolveStyle(doc);
    const failing = styleContrastChecks(concreteStyleTable(resolved.cssVars))
      .filter((c) => c.ratio !== null && c.ratio < c.min)
      .map((c) => `${c.fg} on ${c.bg}`);
    const warned = resolved.warnings.filter((w) => w.code === 'low-contrast').map((w) => w.key);
    expect(warned).toEqual(failing);
    expect(failing).toContain('--pn-ink on --pn-paper');
  });
});

describe('Variables tab: every registry key has its kind widget (§2)', () => {
  it('renders a row per non-ANSI key, a 16-cell ANSI grid, and hides derived keys', async () => {
    await openEditor();
    await tab('Variables');
    const ansi = /^--pn-x-term-ansi-\d+$/;
    for (const e of STYLE_REGISTRY.entries) {
      const row = document.querySelector(`.styleed__var[data-key="${e.key}"]`);
      if (e.kind === 'derived' || ansi.test(e.key)) expect(row, e.key).toBeNull();
      else expect(row, e.key).not.toBeNull();
    }
    const grid = screen.getByTestId('ansi-grid');
    expect(within(grid).getAllByRole('button')).toHaveLength(16);
  });

  it('a stepper writes a value the grammar accepts, in the entry unit', async () => {
    await openEditor();
    await tab('Variables');
    await act(async () => {
      fireEvent.click(screen.getByLabelText('increase --pn-fs-body'));
    });
    flushStyleDraft();
    expect(getStyleState().doc.vars['--pn-fs-body']).toBe('15px');
    await act(async () => {
      fireEvent.click(screen.getByLabelText('increase --pn-term-line-height'));
    });
    flushStyleDraft();
    const lh = getStyleState().doc.vars['--pn-term-line-height']!;
    expect(lh).toBe('1.25');
    expect(valid('--pn-term-line-height', lh)).toBe(true);
  });

  it('the auto keyword toggles on number keys that list it', async () => {
    await openEditor();
    await tab('Variables');
    const row = document.querySelector('.styleed__var[data-key="--pn-term-font-size"]') as HTMLElement;
    const auto = within(row).getByRole('checkbox') as HTMLInputElement;
    expect(auto.checked).toBe(true);
    await act(async () => {
      fireEvent.click(auto);
    });
    flushStyleDraft();
    const size = getStyleState().doc.vars['--pn-term-font-size']!;
    expect(valid('--pn-term-font-size', size)).toBe(true);
    expect(size).not.toBe('auto');
  });

  it('the colour picker writes a colour; translucent keys keep their alpha', async () => {
    await openEditor();
    await tab('Variables');
    await act(async () => {
      fireEvent.click(screen.getByLabelText('--pn-brand-soft colour'));
    });
    const alpha = screen.getByLabelText('alpha') as HTMLInputElement;
    await act(async () => {
      fireEvent.change(alpha, { target: { value: '0.3' } });
    });
    flushStyleDraft();
    const v = getStyleState().doc.vars['--pn-brand-soft']!;
    expect(v).toMatch(/^rgba\(\d+, \d+, \d+, 0\.3\)$/);
    expect(valid('--pn-brand-soft', v)).toBe(true);
  });

  it('opaque keys get no alpha slider', async () => {
    await openEditor();
    await tab('Variables');
    await act(async () => {
      fireEvent.click(screen.getByLabelText('--pn-brand colour'));
    });
    expect(screen.queryByLabelText('alpha')).toBeNull();
    await act(async () => {
      fireEvent.change(screen.getByLabelText('hue'), { target: { value: '200' } });
    });
    flushStyleDraft();
    expect(getStyleState().doc.vars['--pn-brand']).toMatch(/^#[0-9a-f]{6}$/);
  });

  it('font, easing and shadow widgets emit valid values and show their preview', async () => {
    await openEditor();
    await tab('Variables');
    const font = screen.getByLabelText('--pn-mono font') as HTMLSelectElement;
    const system = [...font.options].find((o) => o.textContent === 'System mono')!;
    await act(async () => {
      fireEvent.change(font, { target: { value: system.value } });
    });
    const easing = screen.getByLabelText('--pn-ease-standard preset') as HTMLSelectElement;
    await act(async () => {
      fireEvent.change(easing, { target: { value: 'cubic-bezier(0.34, 1.56, 0.64, 1)' } });
    });
    flushStyleDraft();
    const vars = getStyleState().doc.vars;
    expect(valid('--pn-mono', vars['--pn-mono']!)).toBe(true);
    expect(valid('--pn-ease-standard', vars['--pn-ease-standard']!)).toBe(true);
    expect((screen.getByTestId('shadow---pn-sh-md') as HTMLElement).style.boxShadow).not.toBe('');
  });

  it('"Scale all sizes ×" writes the twelve --pn-fs-* keys', async () => {
    await openEditor();
    await tab('Variables');
    const slider = screen.getByLabelText('Scale all sizes ×') as HTMLInputElement;
    await act(async () => {
      fireEvent.change(slider, { target: { value: '1.25' } });
    });
    flushStyleDraft();
    const fs = Object.keys(getStyleState().doc.vars).filter((k) => k.startsWith('--pn-fs-'));
    expect(fs).toHaveLength(12);
    expect(getStyleState().doc.vars['--pn-fs-body']).toBe('17.5px');
  });
});

describe('Widgets tab (§9.2)', () => {
  it('shows the contrast strip, the xterm sample and the ANSI grid; failures never block Save', async () => {
    await openEditor({ ...styleDocForBuiltin('builtin:atelier-light'), vars: { '--pn-ink': '#EEEEEE' } });
    await tab('Widgets');
    const strip = screen.getByTestId('contrast-strip');
    expect(strip.querySelectorAll('[data-fail]').length).toBeGreaterThan(0);
    expect(strip.textContent).toContain('Save and Push still work');
    const sample = screen.getByTestId('xterm-sample');
    expect(sample.dataset.cursor).toBe('block');
    expect(sample.style.fontFamily).toContain('JetBrains Mono');
    expect(within(screen.getByTestId('ansi-grid')).getAllByRole('button')).toHaveLength(16);
  });
});

describe('picker hover preview (§9.1)', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  const mouse = { pointerType: 'mouse' } as never;

  it('paints after the pointer settles for 400 ms and reverts on leave', async () => {
    const { result } = renderHook(() => useHoverPreview(null, true));
    const row = result.current.bind('builtin:atelier-dark', false);
    row.onPointerEnter(mouse);
    await act(async () => {
      vi.advanceTimersByTime(HOVER_PREVIEW_MS - 50);
    });
    row.onPointerMove(mouse); // still moving: the wait restarts
    await act(async () => {
      vi.advanceTimersByTime(HOVER_PREVIEW_MS - 50);
    });
    flushStyleDraft();
    expect(hasDraft()).toBe(false);
    await act(async () => {
      vi.advanceTimersByTime(60);
    });
    flushStyleDraft();
    expect(hasDraft()).toBe(true);
    expect(getStyleState().active.darkish).toBe(true);
    row.onPointerLeave();
    flushStyleDraft();
    expect(hasDraft()).toBe(false);
    expect(getStyleState().active.darkish).toBe(false);
  });

  it('ignores touch, and fetches a personal style once, without its css when css is not allowed', async () => {
    const doc: StyleDoc = { ...styleDocForBuiltin('builtin:atelier-light'), css: '.x { color: red }' };
    const style = vi.fn(async () => personal(doc));
    const { result } = renderHook(() => useHoverPreview({ style }, true));
    const row = result.current.bind('personal:p1', false);
    row.onPointerEnter({ pointerType: 'touch' } as never);
    await act(async () => {
      vi.advanceTimersByTime(HOVER_PREVIEW_MS + 10);
    });
    expect(style).not.toHaveBeenCalled();
    row.onPointerEnter(mouse);
    await act(async () => {
      vi.advanceTimersByTime(HOVER_PREVIEW_MS + 10);
    });
    flushStyleDraft();
    expect(style).toHaveBeenCalledTimes(1);
    expect(getStyleState().active.css).toBeNull();
    row.onPointerLeave();
    row.onPointerEnter(mouse);
    await act(async () => {
      vi.advanceTimersByTime(HOVER_PREVIEW_MS + 10);
    });
    expect(style).toHaveBeenCalledTimes(1);
  });
});

describe('picker upstream badge (§9.1)', () => {
  it('shows "upstream vN available" when the space style moved on', async () => {
    const row = (id: string, version: number, upstream: number | null): PersonalStyleSummary => ({
      id,
      ref: `personal:${id}`,
      title: `Style ${id}`,
      foundation: 'builtin:atelier-light',
      varCount: 0,
      hasCss: false,
      tags: [],
      version: 1,
      resolvedHash: null,
      publishedAs: null,
      publishedVersion: null,
      pulledFrom: { id: 'space-style', version, upstreamVersion: upstream },
      updatedAt: '2026-10-02T00:00:00Z',
    });
    render(
      createElement(StylePicker, {
        seam: { personalStyles: async () => ({ items: [row('a', 2, 5), row('b', 3, 3)] }) as never },
        spaceId: null,
        members: [],
      }),
    );
    await act(async () => {
      fireEvent.click(screen.getByTestId('style-picker-toggle'));
    });
    await screen.findByText('Style a');
    const badges = screen.getAllByTestId('style-upstream-badge');
    expect(badges).toHaveLength(1);
    expect(badges[0]!.textContent).toBe('upstream v5 available');
  });
});
