/**
 * The Workspace rows of the keyboard contract (task 01a113aa): the `n` / `l` /
 * `t` chord leads, tabs, Design, chat, launch, help, and the `Ctrl+]`
 * terminal chord — and the two promises every one of them keeps: dead while
 * typing, and never a chord the browser owns.
 */
import { describe, expect, it } from 'vitest';
import {
  BINDINGS,
  BINDING_GROUPS,
  bindingGroup,
  createKeyboardController,
  hintFor,
  isBrowserReserved,
  isTerminalBlurChord,
  isTerminalToggleChord,
  type KeyInput,
  type KeyboardContext,
} from './index';

function key(partial: Partial<KeyInput> & { key: string }): KeyInput {
  return {
    code: partial.code ?? `Key${partial.key.toUpperCase()}`,
    ctrlKey: false,
    metaKey: false,
    altKey: false,
    shiftKey: false,
    ...partial,
  };
}

function controller(context: Partial<KeyboardContext> = {}) {
  const commands: { command: string; ref?: string }[] = [];
  const c = createKeyboardController({
    platform: 'mac',
    now: () => 1_000,
    onCommand: (command, ref) => commands.push({ command, ref }),
  });
  c.setContext(context);
  return { c, commands };
}

const press = (keys: string, context: Partial<KeyboardContext> = {}) => {
  const { c, commands } = controller(context);
  for (const k of keys.split(' ')) c.handle(key({ key: k }));
  return commands;
};

describe('Workspace bindings', () => {
  it.each([
    ['n t', 'work.create', 'task'],
    ['n d', 'work.create', 'doc'],
    ['n s', 'work.create', 'work_session'],
    ['n x', 'work.create', 'drawing'],
    ['n y', 'work.create', 'story'],
    ['n o', 'work.create', 'collection'],
    ['n h', 'work.create', 'channel'],
    ['n k', 'work.create', 'skill'],
    ['n m', 'work.create', 'team_member'],
    ['n n', 'work.newTab', undefined],
    ['l l', 'work.browser.focus', undefined],
    ['l t', 'work.browser.focus', 'task'],
    ['l s', 'work.browser.focus', 'work_session'],
    ['l a', 'work.browser.focus', 'artifact'],
    ['l 1', 'work.browser.focus', 'pin:1'],
    ['l 9', 'work.browser.focus', 'pin:9'],
    ['t e', 'work.tab.section', 'entity'],
    ['t l', 'work.tab.section', 'connections'],
    ['t m', 'work.tab.section', 'messages'],
    ['t c', 'work.tab.chat', undefined],
    ['t f', 'work.tab.fullscreen', undefined],
    ['t r', 'work.launch', undefined],
    [']', 'work.tab.next', undefined],
    ['[', 'work.tab.prev', undefined],
    ['3', 'work.tab.nth', '3'],
    ['9', 'work.tab.nth', '9'],
    ['w', 'work.tab.close', undefined],
    ['d', 'work.design.toggle', undefined],
    ['m', 'work.chat.focus', undefined],
    ['r', 'work.launch', undefined],
    ['c', 'list.create', undefined],
    ['?', 'help.open', undefined],
    ['/', 'palette.open', undefined],
  ])('%s → %s(%s)', (keys, command, ref) => {
    expect(press(keys)).toEqual([{ command, ref }]);
  });

  it('keeps the g chords where they were', () => {
    expect(press('g t')).toEqual([{ command: 'nav.kind', ref: 'tasks' }]);
  });

  it('a chord letter only means something under its own lead', () => {
    // `t` then `t` is not a binding: cancelled, consumed, nothing fires.
    expect(press('t t')).toEqual([]);
    // `n` then `e` likewise.
    expect(press('n e')).toEqual([]);
  });

  it('every plain key and chord is dead while typing', () => {
    for (const keys of ['n t', 'l l', 't f', ']', '1', 'w', 'd', 'm', 'r', 'c', '?']) {
      expect(press(keys, { textEntry: true }), keys).toEqual([]);
    }
  });

  it('Esc in a text field emits text.blur, so the shell can drop focus', () => {
    const { c, commands } = controller({ textEntry: true });
    expect(c.handle(key({ key: 'Escape', code: 'Escape' })).consumed).toBe(true);
    expect(commands).toEqual([{ command: 'text.blur', ref: undefined }]);
  });

  it('Ctrl+] is live while typing and outside — it returns to the terminal', () => {
    for (const context of [{}, { textEntry: true }]) {
      const { c, commands } = controller(context);
      c.handle(key({ key: ']', code: 'BracketRight', ctrlKey: true }));
      expect(commands).toEqual([{ command: 'terminal.toggle', ref: undefined }]);
    }
  });

  it('inside a focused terminal Ctrl+] is the terminal’s own (it leaves), never the PTY’s', () => {
    const input = key({ key: ']', code: 'BracketRight', ctrlKey: true });
    expect(isTerminalToggleChord(input)).toBe(true);
    expect(isTerminalBlurChord(input)).toBe(true);
    // The old chord still works.
    expect(isTerminalBlurChord(key({ key: '`', code: 'Backquote', ctrlKey: true }))).toBe(true);
    // A bare ] and Cmd+] are not it.
    expect(isTerminalToggleChord(key({ key: ']', code: 'BracketRight' }))).toBe(false);
    expect(isTerminalToggleChord(key({ key: ']', code: 'BracketRight', metaKey: true }))).toBe(false);
  });

  it('binds no browser-owned chord: Mod+W/T/N, Mod+1…9 stay the browser’s', () => {
    for (const k of ['w', 't', 'n', '1', '9']) {
      const { c, commands } = controller();
      c.handle(key({ key: k, metaKey: true }));
      expect(commands, `Mod+${k}`).toEqual([]);
    }
    expect(isBrowserReserved(key({ key: 'w', metaKey: true }), 'mac')).toBe(true);
  });

  it('documents the tab strip’s own Mod+Alt chords without intercepting them', () => {
    const rows = BINDINGS.filter((b) => b.surfaceOwned && b.id.startsWith('work.tab.'));
    expect(rows.map((b) => b.keys)).toEqual(['Mod+Alt+→', 'Mod+Alt+←', 'Mod+Alt+W']);
    const { c, commands } = controller();
    c.handle(key({ key: 'ArrowRight', code: 'ArrowRight', metaKey: true, altKey: true }));
    expect(commands).toEqual([]);
  });

  it('puts every binding in a help section', () => {
    for (const binding of BINDINGS) expect(BINDING_GROUPS).toContain(bindingGroup(binding));
    expect(bindingGroup(BINDINGS.find((b) => b.id === 'n.task')!)).toBe('Create');
    expect(bindingGroup(BINDINGS.find((b) => b.id === 'l.task')!)).toBe('Lists');
    expect(bindingGroup(BINDINGS.find((b) => b.id === 'work.tab.close')!)).toBe('Workspace');
  });

  it('names the hint for a command, per platform', () => {
    expect(hintFor('nav.kind', 'tasks', 'mac')).toBe('g t');
    expect(hintFor('palette.open', undefined, 'other')).toBe('/');
    expect(hintFor('work.create', 'task', 'other')).toBe('n t');
  });
});
