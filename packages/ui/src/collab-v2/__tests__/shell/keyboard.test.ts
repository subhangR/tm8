/**
 * L3 — the keyboard map: ⌘K palette, ⌫ pop (never while typing), Esc, the
 * `g …` view-jump chord, and the arrow-key helper collections will wire in.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useNavStore } from '../../stores/nav';
import {
  CHORD_TIMEOUT_MS, createKeyboardMap, createListKeyNav, installKeyboard, isTypingTarget,
  type KeyAction, type KeyEventLike,
} from '../../shell/keyboard';

const nav = () => useNavStore.getState();

function press(map: ReturnType<typeof createKeyboardMap>, key: string, extra: Partial<KeyEventLike> = {}) {
  const preventDefault = vi.fn();
  const handled = map.handle({ key, preventDefault, ...extra });
  return { handled, preventDefault };
}

let clock = 0;
const now = () => clock;

beforeEach(() => { nav().reset(); nav().setSpace('space-1'); clock = 0; });

describe('palette', () => {
  it('⌘K and Ctrl-K toggle the palette state', () => {
    const map = createKeyboardMap({ now });
    expect(press(map, 'k', { metaKey: true }).handled).toBe(true);
    expect(nav().paletteOpen).toBe(true);
    press(map, 'k', { ctrlKey: true });
    expect(nav().paletteOpen).toBe(false);
  });

  it('⌘K still works from inside a text input', () => {
    const map = createKeyboardMap({ now });
    const input = document.createElement('input');
    expect(press(map, 'k', { metaKey: true, target: input }).handled).toBe(true);
    expect(nav().paletteOpen).toBe(true);
  });

  it('Escape closes the palette before touching the stack', () => {
    const map = createKeyboardMap({ now });
    nav().pushPanel({ entityId: 'T-1' });
    nav().openPalette();
    press(map, 'Escape');
    expect(nav().paletteOpen).toBe(false);
    expect(nav().stack).toHaveLength(1);
    press(map, 'Escape');
    expect(nav().stack).toHaveLength(0);
  });
});

describe('panel pop', () => {
  it('Backspace pops the top panel', () => {
    const map = createKeyboardMap({ now });
    nav().pushPanel({ entityId: 'T-1' });
    nav().pushPanel({ entityId: 'T-2' });
    const { handled, preventDefault } = press(map, 'Backspace');
    expect(handled).toBe(true);
    expect(preventDefault).toHaveBeenCalled();
    expect(nav().stack.map((r) => r.entityId)).toEqual(['T-1']);
  });

  it('Backspace is inert while typing', () => {
    const map = createKeyboardMap({ now });
    nav().pushPanel({ entityId: 'T-1' });
    for (const el of [document.createElement('input'), document.createElement('textarea')]) {
      expect(press(map, 'Backspace', { target: el }).handled).toBe(false);
    }
    const editable = document.createElement('div');
    Object.defineProperty(editable, 'isContentEditable', { value: true });
    expect(press(map, 'Backspace', { target: editable }).handled).toBe(false);
    expect(nav().stack).toHaveLength(1);
  });

  it('Backspace with an empty stack is not consumed', () => {
    const map = createKeyboardMap({ now });
    expect(press(map, 'Backspace').handled).toBe(false);
  });

  it('isTypingTarget recognises role=textbox', () => {
    const el = document.createElement('div');
    el.setAttribute('role', 'textbox');
    expect(isTypingTarget(el)).toBe(true);
    expect(isTypingTarget(document.createElement('div'))).toBe(false);
    expect(isTypingTarget(null)).toBe(false);
  });
});

describe('g … view jumps', () => {
  it('g then t / d / h moves the center view', () => {
    const actions: KeyAction[] = [];
    const map = createKeyboardMap({ now, onAction: (a) => actions.push(a) });

    press(map, 'g');
    expect(map.pendingChord()).toBe('g');
    press(map, 't');
    expect(nav().view).toBe('tasks');

    press(map, 'g'); press(map, 'd');
    expect(nav().view).toBe('docs');

    press(map, 'g'); press(map, 'h');
    expect(nav().view).toBe('home');
    expect(actions).toContain('view.tasks');
  });

  it('expires the chord after the timeout', () => {
    const map = createKeyboardMap({ now });
    press(map, 'g');
    clock += CHORD_TIMEOUT_MS + 1;
    expect(map.pendingChord()).toBeNull();
    expect(press(map, 't').handled).toBe(false);
    expect(nav().view).toBe('home');
  });

  it('an unmapped second key cancels the chord', () => {
    const map = createKeyboardMap({ now });
    press(map, 'g');
    expect(press(map, 'z').handled).toBe(false);
    expect(map.pendingChord()).toBeNull();
    expect(nav().view).toBe('home');
  });

  it('does not start a chord while typing', () => {
    const map = createKeyboardMap({ now });
    press(map, 'g', { target: document.createElement('input') });
    expect(map.pendingChord()).toBeNull();
  });
});

describe('installKeyboard', () => {
  it('binds and unbinds a keydown listener', () => {
    const stop = installKeyboard(window, { now });
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'k', metaKey: true }));
    expect(nav().paletteOpen).toBe(true);
    stop();
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'k', metaKey: true }));
    expect(nav().paletteOpen).toBe(true);
  });
});

describe('createListKeyNav', () => {
  const setup = (over: Partial<Parameters<typeof createListKeyNav>[0]> = {}) => {
    const onIndexChange = vi.fn();
    const onActivate = vi.fn();
    const handle = createListKeyNav({ count: 4, index: 1, onIndexChange, onActivate, ...over });
    return { handle, onIndexChange, onActivate };
  };

  it('moves with arrows and clamps at the edges', () => {
    const { handle, onIndexChange } = setup();
    expect(handle({ key: 'ArrowDown', preventDefault: vi.fn() })).toBe(true);
    expect(onIndexChange).toHaveBeenCalledWith(2);
    handle({ key: 'ArrowUp', preventDefault: vi.fn() });
    expect(onIndexChange).toHaveBeenLastCalledWith(0);

    const top = setup({ index: 0 });
    top.handle({ key: 'ArrowUp', preventDefault: vi.fn() });
    expect(top.onIndexChange).not.toHaveBeenCalled();
  });

  it('loops when asked', () => {
    const { handle, onIndexChange } = setup({ index: 3, loop: true });
    handle({ key: 'ArrowDown', preventDefault: vi.fn() });
    expect(onIndexChange).toHaveBeenCalledWith(0);
  });

  it('grid orientation moves by a row', () => {
    const { handle, onIndexChange } = setup({ count: 9, index: 0, orientation: 'grid', columns: 3 });
    handle({ key: 'ArrowDown', preventDefault: vi.fn() });
    expect(onIndexChange).toHaveBeenCalledWith(3);
    handle({ key: 'ArrowRight', preventDefault: vi.fn() });
    expect(onIndexChange).toHaveBeenLastCalledWith(1);
  });

  it('vertical lists ignore horizontal arrows; Home/End jump; Enter activates', () => {
    const { handle, onIndexChange, onActivate } = setup();
    expect(handle({ key: 'ArrowRight', preventDefault: vi.fn() })).toBe(false);
    handle({ key: 'End', preventDefault: vi.fn() });
    expect(onIndexChange).toHaveBeenLastCalledWith(3);
    handle({ key: 'Home', preventDefault: vi.fn() });
    expect(onIndexChange).toHaveBeenLastCalledWith(0);
    handle({ key: 'Enter', preventDefault: vi.fn() });
    expect(onActivate).toHaveBeenCalledWith(1);
  });
});
