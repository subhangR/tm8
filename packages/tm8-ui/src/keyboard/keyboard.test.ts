/**
 * The keyboard contract, one test per binding ROW (LLD §15.5, WLT §5.8).
 *
 * The priority chain is what makes these deterministic: each layer consumes
 * what it handles, so nothing here depends on listener order. jsdom is not
 * involved — `handle()` takes a normalized key input, which is why every row
 * is testable at all (RULING G: "specified, jsdom-testable").
 *
 * NOT covered here (deferred-not-waived, D10): the real-browser proof that
 * typing `j` into a focused terminal reaches the PTY and leaves list selection
 * unmoved, and the zero-PTY-bytes measurement on the blur chord. Those are
 * browser tests at the R5 gate; jsdom has no terminal and no PTY.
 */
import { describe, expect, it } from 'vitest';
import {
  BINDINGS,
  CHORD_LEAD,
  createKeyboardController,
  isAdvertised,
  isBrowserReserved,
  isTerminalBlurChord,
  type KeyInput,
  type KeyboardContext,
  type Platform,
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

function controller(context: Partial<KeyboardContext> = {}, platform: Platform = 'mac') {
  const commands: { command: string; ref?: string }[] = [];
  let clock = 1_000;
  const c = createKeyboardController({
    platform,
    now: () => clock,
    onCommand: (command, ref) => commands.push({ command, ref }),
  });
  c.setContext(context);
  return { c, commands, advance: (ms: number) => (clock += ms) };
}

describe('layer 1 — browser/OS is never intercepted', () => {
  const reserved: KeyInput[] = [
    key({ key: 'w', metaKey: true }),
    key({ key: 't', metaKey: true }),
    key({ key: 'n', metaKey: true }),
    key({ key: 'l', metaKey: true }),
    key({ key: 'q', metaKey: true }),
    key({ key: 'Tab', ctrlKey: true, code: 'Tab' }),
    key({ key: 'F11', code: 'F11' }),
  ];

  it.each(reserved.map((k) => [k.key, k] as const))('never consumes %s', (_label, input) => {
    expect(isBrowserReserved(input, 'mac')).toBe(true);
    const { c, commands } = controller({ focusScope: true });
    const result = c.handle(input);
    expect(result.consumed).toBe(false);
    expect(result.layer).toBe('browser');
    expect(commands).toEqual([]);
  });

  it('no binding in the table uses a hard-excluded chord', () => {
    for (const binding of BINDINGS) {
      if (binding.match.type !== 'mod') continue;
      for (const platform of ['mac', 'other'] as const) {
        const input = key({
          key: binding.match.key,
          metaKey: platform === 'mac',
          ctrlKey: platform !== 'mac',
        });
        expect(isBrowserReserved(input, platform)).toBe(false);
      }
    }
  });
});

describe('layer 2 — modal closes only itself', () => {
  it('Esc closes the topmost surface and does NOT also pop the stack', () => {
    const { c, commands } = controller({ modalDepth: 1, focusScope: true });
    const result = c.handle(key({ key: 'Escape', code: 'Escape' }));
    expect(result.consumed).toBe(true);
    expect(result.layer).toBe('modal');
    expect(commands).toEqual([{ command: 'modal.close', ref: undefined }]);
  });

  it('lets non-Esc keys fall through — a palette has its own text input', () => {
    const { c, commands } = controller({ modalDepth: 1, textEntry: true });
    c.handle(key({ key: 'j' }));
    expect(commands).toEqual([]);
  });
});

describe('layer 3 — a focused terminal owns the keyboard', () => {
  it('does not consume ordinary keys — they reach xterm and the PTY', () => {
    const { c, commands } = controller({ terminalFocused: true, focusScope: true });
    const result = c.handle(key({ key: 'j' }));
    expect(result.consumed).toBe(false);
    expect(result.reason).toBe('terminal-owns');
    // The list binding must NOT have fired: chrome shortcuts never reach a PTY,
    // and list selection must be unmoved.
    expect(commands).toEqual([]);
  });

  it('does not consume a g-chord lead either', () => {
    const { c } = controller({ terminalFocused: true });
    expect(c.handle(key({ key: CHORD_LEAD })).consumed).toBe(false);
    expect(c.chordLead()).toBeNull();
  });

  it('exits on the PHYSICAL Ctrl+Backquote, layout-independent', () => {
    // Matched on event.code, so a layout where ` is elsewhere still works.
    expect(isTerminalBlurChord({ ...key({ key: 'ω' }), code: 'Backquote', ctrlKey: true })).toBe(true);
    const { c, commands } = controller({ terminalFocused: true });
    const result = c.handle({ ...key({ key: '`' }), code: 'Backquote', ctrlKey: true });
    expect(result.consumed).toBe(true);
    expect(commands).toEqual([{ command: 'terminal.blur', ref: undefined }]);
  });

  it('grants NO authority to a hidden lease — surface must be terminal', () => {
    // A retained pool lease while Chat is selected is not keyboard ownership.
    const { c, commands } = controller({
      terminalFocused: true,
      terminalSurface: 'chat',
      focusScope: true,
    });
    const result = c.handle(key({ key: 'j' }));
    expect(result.layer).toBe('focus');
    expect(commands).toEqual([{ command: 'list.next', ref: undefined }]);
  });
});

describe('layer 4 — text entry kills every plain key', () => {
  it.each(['j', 'k', 'c', 'p', CHORD_LEAD, '/', 'Enter'])('is dead on %s', (k) => {
    const { c, commands } = controller({ textEntry: true, focusScope: true });
    const result = c.handle(key({ key: k, code: k === 'Enter' ? 'Enter' : undefined }));
    expect(result.reason).toBe('dead-in-text-entry');
    expect(commands).toEqual([]);
  });

  it('keeps Mod chords live where receivable', () => {
    const { c, commands } = controller({ textEntry: true });
    expect(c.handle(key({ key: 'k', metaKey: true })).consumed).toBe(true);
    expect(commands).toEqual([{ command: 'palette.open', ref: undefined }]);
  });

  it('blurs on Esc, consumed', () => {
    const { c, commands } = controller({ textEntry: true, focusScope: true });
    const result = c.handle(key({ key: 'Escape', code: 'Escape' }));
    expect(result.consumed).toBe(true);
    // Esc blurs the field — it does not ALSO pop the panel behind it.
    expect(commands).toEqual([{ command: 'text.blur', ref: undefined }]);
  });
});

describe('layer 5 — list and panel bindings', () => {
  const rows: [string, KeyInput, string][] = [
    ['j', key({ key: 'j' }), 'list.next'],
    ['k', key({ key: 'k' }), 'list.prev'],
    ['ArrowDown', key({ key: 'ArrowDown', code: 'ArrowDown' }), 'list.next'],
    ['ArrowUp', key({ key: 'ArrowUp', code: 'ArrowUp' }), 'list.prev'],
    ['Enter', key({ key: 'Enter', code: 'Enter' }), 'list.open'],
    ['Mod+Enter', key({ key: 'Enter', code: 'Enter', metaKey: true }), 'list.primary'],
    ['c', key({ key: 'c' }), 'list.create'],
    ['f', key({ key: 'f' }), 'list.search'],
    ['Escape', key({ key: 'Escape', code: 'Escape' }), 'panel.pop'],
    ['p', key({ key: 'p' }), 'panel.pin'],
  ];

  it.each(rows)('%s → %s', (_label, input, command) => {
    const { c, commands } = controller({ focusScope: true });
    const result = c.handle(input);
    expect(result.consumed).toBe(true);
    expect(commands).toEqual([{ command, ref: undefined }]);
  });

  it('does not fire list bindings without a focused scope', () => {
    const { c, commands } = controller({ focusScope: false });
    c.handle(key({ key: 'j' }));
    expect(commands).toEqual([]);
  });
});

describe('D36 — in-panel search must not cost the palette its guaranteed path', () => {
  it('keeps / on the PALETTE even while a list is focused', () => {
    // This is the whole ruling. A focused list is the workspace's most common
    // state; if it consumed `/`, the palette's guaranteed path would be gone
    // exactly there — and ⌘K is browser-owned on Chrome Win/Linux and Firefox,
    // so on half the matrix the palette would have NO reachable binding.
    const { c, commands } = controller({ focusScope: true });
    const result = c.handle(key({ key: '/', code: 'Slash' }));
    expect(result.layer).toBe('global');
    expect(commands).toEqual([{ command: 'palette.open', ref: undefined }]);
  });

  it('gives search its own guaranteed plain key at layer 5', () => {
    const { c, commands } = controller({ focusScope: true });
    expect(c.handle(key({ key: 'f' })).consumed).toBe(true);
    expect(commands).toEqual([{ command: 'list.search', ref: undefined }]);
  });

  it('never binds Mod+F — every browser owns its find bar (R8-3)', () => {
    expect(BINDINGS.some((b) => b.match.type === 'mod' && b.match.key === 'f')).toBe(false);
  });

  it('leaves the terminal layer untouched: a focused terminal still owns f', () => {
    const { c, commands } = controller({ terminalFocused: true, focusScope: true });
    const result = c.handle(key({ key: 'f' }));
    expect(result.reason).toBe('terminal-owns');
    expect(result.consumed).toBe(false);
    expect(commands).toEqual([]);
  });

  it('is dead once the search field itself has focus, and Esc blurs it', () => {
    // Layer 4 outranks layer 5, so typing `f` into the field types an f, and
    // Esc blurs the FIELD rather than popping the panel stack.
    const { c, commands } = controller({ textEntry: true, focusScope: true });
    expect(c.handle(key({ key: 'f' })).reason).toBe('dead-in-text-entry');
    expect(commands).toEqual([]);
    c.handle(key({ key: 'Escape', code: 'Escape' }));
    expect(commands).toEqual([{ command: 'text.blur', ref: undefined }]);
  });
});

describe('layer 6 — global chrome', () => {
  it('opens the palette on plain / everywhere (the guaranteed path)', () => {
    const { c, commands } = controller();
    expect(c.handle(key({ key: '/', code: 'Slash' })).consumed).toBe(true);
    expect(commands).toEqual([{ command: 'palette.open', ref: undefined }]);
  });

  it('toggles the menu rail on Mod+\\', () => {
    const { c, commands } = controller();
    c.handle(key({ key: '\\', code: 'Backslash', metaKey: true }));
    expect(commands).toEqual([{ command: 'menu.toggle', ref: undefined }]);
  });
});

describe('the g-chord machine', () => {
  const chords: [string, string, string | undefined][] = [
    ['h', 'nav.view', 'home'],
    ['t', 'nav.kind', 'tasks'],
    ['s', 'nav.kind', 'sessions'],
    ['d', 'nav.kind', 'docs'],
    ['m', 'nav.kind', 'teammates'],
    ['p', 'nav.kind', 'projects'],
    ['c', 'nav.view', 'channels'],
    ['i', 'nav.view', 'inbox'],
    [',', 'nav.view', 'settings'],
  ];

  it.each(chords)('g %s → %s(%s)', (second, command, ref) => {
    const { c, commands } = controller({ focusScope: true });
    expect(c.handle(key({ key: CHORD_LEAD })).consumed).toBe(true);
    expect(c.chordLead()).toBe(CHORD_LEAD);
    c.handle(key({ key: second }));
    expect(commands).toEqual([{ command, ref }]);
    expect(c.chordLead()).toBeNull();
  });

  it('CANCELS on a non-mapped second key, and consumes it', () => {
    const { c, commands } = controller({ focusScope: true });
    c.handle(key({ key: CHORD_LEAD }));
    const result = c.handle(key({ key: 'z' }));
    expect(result.reason).toBe('chord-cancelled');
    // Consumed on purpose: a mistyped chord must not fall through and fire a
    // plain-key binding the user never asked for.
    expect(result.consumed).toBe(true);
    expect(commands).toEqual([]);
  });

  it('does not let a cancelled chord fire the plain binding for that key', () => {
    const { c, commands } = controller({ focusScope: true });
    c.handle(key({ key: CHORD_LEAD }));
    c.handle(key({ key: 'j' }));
    expect(commands).toEqual([]);
  });

  it('expires after the window, so a forgotten lead swallows nothing', () => {
    const { c, commands, advance } = controller({ focusScope: true });
    c.handle(key({ key: CHORD_LEAD }));
    advance(5_000);
    expect(c.chordLead()).toBeNull();
    c.handle(key({ key: 'j' }));
    expect(commands).toEqual([{ command: 'list.next', ref: undefined }]);
  });

  it('binds to registry/view REFS, never to menu positions', () => {
    // Every g-chord names a slug or a view name; a menu edit cannot reach them.
    for (const binding of BINDINGS) {
      if (binding.match.type !== 'chord') continue;
      expect(binding.ref).toBeTruthy();
      expect(binding.command === 'nav.kind' || binding.command === 'nav.view').toBe(true);
    }
  });
});

describe('advertising discipline (R8-3)', () => {
  it('always advertises the guaranteed plain-key / g-chord core', () => {
    for (const binding of BINDINGS.filter((b) => b.guaranteed)) {
      expect(isAdvertised(binding, 'mac')).toBe(true);
      expect(isAdvertised(binding, 'other')).toBe(true);
    }
  });

  it('hides Mod+K where the browser owns it, and keeps / as the guaranteed path', () => {
    const modK = BINDINGS.find((b) => b.id === 'palette.mod-k')!;
    expect(isAdvertised(modK, 'other')).toBe(false);
    expect(isAdvertised(modK, 'mac')).toBe(true);
    // Every Mod convenience has a non-Mod path to the same command.
    const slash = BINDINGS.find((b) => b.id === 'palette.slash')!;
    expect(slash.guaranteed).toBe(true);
    expect(slash.command).toBe(modK.command);
  });

  it('never binds ⌘, for Settings — g , is the guaranteed path', () => {
    // ⌘, is browser Settings on Chrome/macOS AND Safari/macOS: the contract
    // never advertises a chord the browser owns, so it is not bound at all.
    expect(BINDINGS.some((b) => b.match.type === 'mod' && b.match.key === ',')).toBe(false);
    expect(BINDINGS.find((b) => b.id === 'g.settings')?.guaranteed).toBe(true);
  });

  it('never binds ⌘. for pin — plain p replaces the withdrawn chord', () => {
    expect(BINDINGS.some((b) => b.match.type === 'mod' && b.match.key === '.')).toBe(false);
    expect(BINDINGS.find((b) => b.id === 'panel.pin')?.match).toEqual({ type: 'plain', key: 'p' });
  });

  it('resolves Mod per platform: Meta on mac, Ctrl elsewhere', () => {
    const mac = controller({}, 'mac');
    mac.c.handle(key({ key: 'k', ctrlKey: true }));
    expect(mac.commands).toEqual([]);

    const other = controller({}, 'other');
    other.c.handle(key({ key: 'k', ctrlKey: true }));
    expect(other.commands).toEqual([{ command: 'palette.open', ref: undefined }]);
  });
});

describe('table hygiene', () => {
  it('has unique binding ids', () => {
    const ids = BINDINGS.map((b) => b.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('gives every binding a hint string and a label', () => {
    for (const b of BINDINGS) {
      expect(b.keys.length).toBeGreaterThan(0);
      expect(b.label.length).toBeGreaterThan(0);
    }
  });
});
