// @vitest-environment jsdom
/**
 * The editor's two pure seams: the store's live draft (spec §9.2 "every
 * keystroke → applyDraft") and the file helpers behind Import / Export.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { createElement } from 'react';
import { act, fireEvent, render, screen } from '@testing-library/react';
import {
  exportStyle,
  importStyle,
  resolveStyle,
  styleDocForBuiltin,
  type PersonalStyleView,
  type StyleDoc,
  type StyleGetResult,
} from '@tm8/contract';

import {
  ACTIVE_STYLE_ELEMENT_ID,
  __resetStyleStoreForTests,
  applyDraft,
  derivedTheme,
  flushStyleDraft,
  getStyleState,
  hasDraft,
  installActiveStyle,
  selectStyle,
  subscribeStyle,
} from './style-store';
import { StyleEditor } from './StyleEditor';
import { styleFileName, titleFromFileName } from './style-io';

function sheetText(): string {
  return document.getElementById(ACTIVE_STYLE_ELEMENT_ID)?.textContent ?? '';
}

describe('applyDraft: preview in this tab, never committed', () => {
  beforeEach(() => {
    localStorage.clear();
    __resetStyleStoreForTests();
    selectStyle('builtin:atelier-light');
    installActiveStyle();
  });

  it('paints the draft, reports it as active, and reverts on null', () => {
    const committed = getStyleState();
    const draft: StyleDoc = {
      ...styleDocForBuiltin('builtin:atelier-dark'),
      vars: { '--pn-brand': '#4F7DF3' },
    };
    applyDraft(draft);
    flushStyleDraft();
    expect(hasDraft()).toBe(true);
    expect(getStyleState().doc).toBe(draft);
    expect(derivedTheme()).toBe('dark');
    expect(sheetText()).toContain('#4F7DF3');
    /* The committed pair underneath is untouched. */
    expect(getStyleState().current).toBe(committed.current);

    applyDraft(null);
    flushStyleDraft();
    expect(hasDraft()).toBe(false);
    expect(getStyleState()).toBe(committed);
    expect(derivedTheme()).toBe('light');
    expect(sheetText()).not.toContain('#4F7DF3');
  });

  it('never writes the draft to the boot cache', () => {
    const before = localStorage.getItem('tm8ui.style');
    applyDraft({ ...styleDocForBuiltin('builtin:atelier-light'), vars: { '--pn-brand': '#123456' } });
    flushStyleDraft();
    expect(localStorage.getItem('tm8ui.style')).toBe(before);
    applyDraft(null);
    flushStyleDraft();
  });

  it('applies at most once per animation frame, and the last draft wins (§6.7)', async () => {
    const seen: string[] = [];
    const off = subscribeStyle((s) => seen.push(s.doc.vars['--pn-brand'] ?? ''));
    for (const brand of ['#111111', '#222222', '#333333']) {
      applyDraft({ ...styleDocForBuiltin('builtin:atelier-light'), vars: { '--pn-brand': brand } });
    }
    /* Nothing is painted or announced until the frame. */
    expect(seen).toEqual([]);
    expect(hasDraft()).toBe(false);
    /* rAF where the environment has it, a 0 ms timer where it does not: either fires by 50 ms. */
    await new Promise<void>((resolve) => setTimeout(resolve, 50));
    expect(seen).toEqual(['#333333']);
    expect(sheetText()).toContain('#333333');
    expect(sheetText()).not.toContain('#222222');
    off();
    applyDraft(null);
    flushStyleDraft();
  });

  it('a commit landing mid-frame folds the pending draft into one paint', () => {
    let calls = 0;
    const off = subscribeStyle(() => calls++);
    applyDraft({ ...styleDocForBuiltin('builtin:atelier-light'), vars: { '--pn-brand': '#444444' } });
    selectStyle('builtin:atelier-dark');
    expect(calls).toBe(1);
    expect(getStyleState().doc.vars['--pn-brand']).toBe('#444444');
    off();
    applyDraft(null);
    flushStyleDraft();
  });
});

describe('the editor warns but never blocks (§9.2)', () => {
  beforeEach(() => {
    localStorage.clear();
    __resetStyleStoreForTests();
  });

  it('shows a low-contrast warning and keeps Save enabled', async () => {
    const doc: StyleDoc = {
      ...styleDocForBuiltin('builtin:atelier-light'),
      vars: { '--pn-paper': '#FFFFFF', '--pn-ink': '#F4F4F4' },
    };
    const view: PersonalStyleView = {
      id: 'p1',
      ref: 'personal:p1',
      title: 'Washed out',
      description: null,
      tags: [],
      version: 3,
      doc,
      resolvedHash: null,
      publishedAs: null,
      publishedVersion: null,
      pulledFrom: null,
      createdAt: '2026-10-02T00:00:00Z',
      updatedAt: '2026-10-02T00:00:00Z',
    };
    const got: StyleGetResult = {
      origin: 'personal',
      ref: view.ref,
      id: view.id,
      title: view.title,
      description: null,
      tags: [],
      version: 3,
      doc,
      resolvedHash: null,
      resolved: resolveStyle(doc),
      warnings: [],
      personal: view,
    };
    render(
      createElement(StyleEditor, {
        seam: { style: async () => got, updatePersonalStyle: async () => ({ style: view, warnings: [], clamped: [] }) },
        target: { kind: 'personal', id: 'p1' },
        spaceId: null,
        members: [],
        onClose: () => {},
      }),
    );
    const strip = await screen.findByTestId('style-warnings');
    expect(strip.textContent).toContain('low-contrast');
    expect(strip.textContent).toContain('Save and Push still work');
    const save = screen.getByTestId('style-editor-save') as HTMLButtonElement;
    expect(save.disabled).toBe(true); // nothing to save yet
    await act(async () => {
      fireEvent.change(screen.getByDisplayValue('Washed out'), { target: { value: 'Washed out 2' } });
    });
    expect(save.disabled).toBe(false);
  });
});

describe('style files', () => {
  it('names files from titles', () => {
    expect(styleFileName('Midnight (draft)', 'json')).toBe('midnight-draft.tm8style.json');
    expect(styleFileName('Midnight (draft)', 'css')).toBe('midnight-draft.css');
    expect(styleFileName('!!!', 'css')).toBe('style.css');
    expect(titleFromFileName('midnight-draft.tm8style.json')).toBe('midnight draft');
  });

  it('an exported file imports back to the same document', () => {
    const doc: StyleDoc = {
      ...styleDocForBuiltin('builtin:atelier-dark'),
      vars: { '--pn-brand': '#4F7DF3' },
    };
    for (const format of ['json', 'css'] as const) {
      const back = importStyle(exportStyle(doc, { format, only: 'set' })).doc;
      expect(back.foundation).toBe('builtin:atelier-dark');
      expect(back.vars['--pn-brand']?.toLowerCase()).toBe('#4f7df3');
    }
  });
});
