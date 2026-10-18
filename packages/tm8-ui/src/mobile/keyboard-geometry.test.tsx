// @vitest-environment jsdom
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { act, render } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';

import { MobileFrame } from './MobileFrame';
import { SHRINK_PX, isEditable, keyboardUp } from './useKeyboardUp';

/**
 * t-safe: composer-states mockup §1 and audit A4/A5. The dock clears the home
 * indicator only while the keyboard is down, and the hero collapses while it is
 * up. Android's resized viewport has to stamp `data-keyboard` too.
 */

const here = dirname(fileURLToPath(import.meta.url));
const strip = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, '');
const chatCss = strip(readFileSync(join(here, '../chat-home/chat-home.css'), 'utf8'));
const indexHtml = readFileSync(join(here, '../../index.html'), 'utf8');

function block(selector: string): string {
  const at = chatCss.indexOf(`${selector} {`);
  expect(at, `no rule for ${selector}`).toBeGreaterThanOrEqual(0);
  return chatCss.slice(at, chatCss.indexOf('}', at));
}

const UP = ".cv2-root[data-shell='mobile'] .mobile-frame[data-keyboard='up']";

describe('viewport meta (A4)', () => {
  it('asks Android to resize content for the keyboard and keeps viewport-fit=cover', () => {
    const meta = indexHtml.match(/<meta name="viewport" content="([^"]+)"/)?.[1] ?? '';
    expect(meta).toContain('interactive-widget=resizes-content');
    expect(meta).toContain('viewport-fit=cover');
  });
});

describe('the dock', () => {
  it('sits 10px + safe-area above the bottom with the keyboard down', () => {
    const body = block(".cv2-root[data-shell='mobile'] .tch-conversation .tch-composer-wrap");
    expect(body).toMatch(/margin:\s*auto auto calc\(10px \+ var\(--mobile-safe-bottom, 0px\)\)/);
  });

  it('drops the safe-area term with the keyboard up', () => {
    expect(block(`${UP} .tch-conversation .tch-composer-wrap`)).toMatch(/margin-bottom:\s*10px;/);
  });
});

describe('the hero collapses with the keyboard up (A5)', () => {
  it('hides the mark and the caption', () => {
    expect(chatCss).toMatch(
      /\.mobile-frame\[data-keyboard='up'\] \.tch-welcome__mark,\s*\.cv2-root\[data-shell='mobile'\] \.mobile-frame\[data-keyboard='up'\] \.tch-welcome p \{\s*display: none;/,
    );
  });

  it('turns the h1 into one muted 17px line', () => {
    const body = block(`${UP} .tch-welcome h1`);
    expect(body).toMatch(/font-size:\s*17px/);
    expect(body).toMatch(/color:\s*var\(--pn-ink-3\)/);
  });
});

describe('keyboardUp', () => {
  const base = { inset: 0, tallest: 780, height: 780, editableFocused: false };

  it('is up whenever the overlay inset is non-zero (iOS)', () => {
    expect(keyboardUp({ ...base, inset: 270 })).toBe(true);
  });

  it('is up when the viewport shrank by a keyboard and a field has focus (Android)', () => {
    expect(keyboardUp({ ...base, height: 510, editableFocused: true })).toBe(true);
  });

  it('is down after Back closes the keyboard but leaves the field focused', () => {
    expect(keyboardUp({ ...base, editableFocused: true })).toBe(false);
  });

  it('ignores a URL-bar-sized change', () => {
    expect(keyboardUp({ ...base, height: 780 - 56, editableFocused: true })).toBe(false);
    expect(keyboardUp({ ...base, height: 780 - SHRINK_PX, editableFocused: true })).toBe(true);
  });

  it('ignores a resize with nothing focused (split screen)', () => {
    expect(keyboardUp({ ...base, height: 400 })).toBe(false);
  });
});

describe('isEditable', () => {
  it('counts text fields and contenteditable, not buttons or read-only fields', () => {
    expect(isEditable(document.createElement('textarea'))).toBe(true);
    expect(isEditable(Object.assign(document.createElement('input'), { type: 'text' }))).toBe(true);
    expect(isEditable(Object.assign(document.createElement('input'), { type: 'checkbox' }))).toBe(false);
    expect(isEditable(Object.assign(document.createElement('textarea'), { readOnly: true }))).toBe(false);
    expect(isEditable(document.createElement('button'))).toBe(false);
    expect(isEditable(null)).toBe(false);
  });
});

describe('MobileFrame stamps data-keyboard from a resized viewport', () => {
  const height0 = window.innerHeight;
  afterEach(() => {
    Object.defineProperty(window, 'innerHeight', { configurable: true, value: height0 });
  });

  it('goes up on focus + shrink and down when the viewport grows back', async () => {
    Object.defineProperty(window, 'innerHeight', { configurable: true, value: 780 });
    const view = render(
      <MobileFrame>
        <textarea data-testid="field" />
      </MobileFrame>,
    );
    const frame = view.container.querySelector('.mobile-frame')!;
    expect(frame.hasAttribute('data-keyboard')).toBe(false);

    await act(async () => {
      (view.getByTestId('field') as HTMLTextAreaElement).focus();
      Object.defineProperty(window, 'innerHeight', { configurable: true, value: 510 });
      window.dispatchEvent(new Event('resize'));
      await new Promise((r) => setTimeout(r, 0));
    });
    expect(frame.getAttribute('data-keyboard')).toBe('up');

    await act(async () => {
      Object.defineProperty(window, 'innerHeight', { configurable: true, value: 780 });
      window.dispatchEvent(new Event('resize'));
    });
    expect(frame.hasAttribute('data-keyboard')).toBe(false);
  });
});
