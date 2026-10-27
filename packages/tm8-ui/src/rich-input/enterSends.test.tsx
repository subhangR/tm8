// @vitest-environment jsdom
/**
 * RETURN ON A PHONE IS A NEWLINE (audit A1) — the rule, and the shared hook
 * every composer reaches it through, so ChatHome, Channel and NewSession agree.
 */
import { useRef, useState } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { enterSends, isSendKey } from './enterSends';
import { useRichInput } from './useRichInput';

describe('enterSends', () => {
  it('sends on a fine pointer at any width, and on a coarse pointer at 500 and up', () => {
    expect(enterSends({ pointer: 'fine', width: 360 })).toBe(true);
    expect(enterSends({ pointer: 'fine', width: 1440 })).toBe(true);
    expect(enterSends({ pointer: 'coarse', width: 500 })).toBe(true);
    expect(enterSends({ pointer: 'coarse', width: 820 })).toBe(true);
  });

  it('is a newline on the phone shell input at 360, 390 and 430', () => {
    for (const width of [360, 390, 430]) expect(enterSends({ pointer: 'coarse', width })).toBe(false);
  });

  it('never sends under Shift or an IME composition', () => {
    expect(isSendKey({ key: 'Enter', shiftKey: false, nativeEvent: {} }, true)).toBe(true);
    expect(isSendKey({ key: 'Enter', shiftKey: true }, true)).toBe(false);
    expect(isSendKey({ key: 'Enter', shiftKey: false, nativeEvent: { isComposing: true } }, true)).toBe(false);
    expect(isSendKey({ key: 'Enter', shiftKey: false }, false)).toBe(false);
  });
});

function setDevice(coarse: boolean, width: number) {
  Object.defineProperty(window, 'innerWidth', { configurable: true, value: width });
  window.matchMedia = ((query: string) => ({
    matches: coarse && query === '(pointer: coarse)',
    media: query,
    addEventListener: () => {},
    removeEventListener: () => {},
  })) as unknown as typeof window.matchMedia;
}

function Host({ onSend }: { onSend: () => void }) {
  const [value, setValue] = useState('');
  const areaRef = useRef<HTMLTextAreaElement | null>(null);
  const rich = useRichInput({ value, onChange: setValue, areaRef, onSend });
  return <textarea aria-label="draft" ref={areaRef} value={value} {...rich.areaProps} />;
}

describe('useRichInput onSend', () => {
  const original = { width: window.innerWidth, matchMedia: window.matchMedia };
  afterEach(() => {
    cleanup();
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: original.width });
    window.matchMedia = original.matchMedia;
  });

  it('desktop: Enter sends and is prevented; Shift+Enter and IME Enter fall through; hint is send', () => {
    setDevice(false, 1280);
    const onSend = vi.fn();
    render(<Host onSend={onSend} />);
    const area = screen.getByLabelText('draft');
    expect(area.getAttribute('enterkeyhint')).toBe('send');
    expect(fireEvent.keyDown(area, { key: 'Enter' })).toBe(false);
    expect(fireEvent.keyDown(area, { key: 'Enter', shiftKey: true })).toBe(true);
    expect(fireEvent.keyDown(area, { key: 'Enter', isComposing: true })).toBe(true);
    expect(onSend).toHaveBeenCalledTimes(1);
  });

  it('phone: Return is a newline — not prevented, never sends; hint is enter', () => {
    for (const width of [360, 390, 430]) {
      setDevice(true, width);
      const onSend = vi.fn();
      render(<Host onSend={onSend} />);
      const area = screen.getByLabelText('draft');
      expect(area.getAttribute('enterkeyhint')).toBe('enter');
      expect(fireEvent.keyDown(area, { key: 'Enter' })).toBe(true);
      expect(onSend).not.toHaveBeenCalled();
      cleanup();
    }
  });
});
