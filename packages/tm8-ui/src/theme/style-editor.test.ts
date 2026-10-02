/**
 * The editor's two pure seams: the store's live draft (spec §9.2 "every
 * keystroke → applyDraft") and the file helpers behind Import / Export.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { exportStyle, importStyle, styleDocForBuiltin, type StyleDoc } from '@tm8/contract';

import {
  ACTIVE_STYLE_ELEMENT_ID,
  __resetStyleStoreForTests,
  applyDraft,
  derivedTheme,
  getStyleState,
  hasDraft,
  installActiveStyle,
  selectStyle,
} from './style-store';
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
    expect(hasDraft()).toBe(true);
    expect(getStyleState().doc).toBe(draft);
    expect(derivedTheme()).toBe('dark');
    expect(sheetText()).toContain('#4F7DF3');
    /* The committed pair underneath is untouched. */
    expect(getStyleState().current).toBe(committed.current);

    applyDraft(null);
    expect(hasDraft()).toBe(false);
    expect(getStyleState()).toBe(committed);
    expect(derivedTheme()).toBe('light');
    expect(sheetText()).not.toContain('#4F7DF3');
  });

  it('never writes the draft to the boot cache', () => {
    const before = localStorage.getItem('tm8ui.style');
    applyDraft({ ...styleDocForBuiltin('builtin:atelier-light'), vars: { '--pn-brand': '#123456' } });
    expect(localStorage.getItem('tm8ui.style')).toBe(before);
    applyDraft(null);
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
