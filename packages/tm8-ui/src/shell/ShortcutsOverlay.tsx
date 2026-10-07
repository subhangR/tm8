/**
 * THE SHORTCUT HELP OVERLAY (`?`, task 01a113aa).
 *
 * Rendered straight from the keyboard contract's `BINDINGS`, so a row added
 * there is listed here with no second list to drift. Two filters keep it
 * honest: a Mod chord the browser owns on this platform is not advertised
 * (R8-3), and the focus-layer rows the shell never activates are left out —
 * a help screen naming a key that does nothing is the same defect as a dead
 * button.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import {
  BINDINGS,
  BINDING_GROUPS,
  bindingGroup,
  isAdvertised,
  type Binding,
  type Platform,
} from '../keyboard';
import './palette.css';
import './shortcuts.css';

/**
 * Focus-layer rows that fire only where a surface handles them itself: the
 * Work browser's row cursor and the board. The rest of layer 5 (`p` pin, `f`
 * search, `Esc` pop, `Mod+Enter`) needs a `focusScope` the shell does not
 * set, so it is not advertised.
 */
const LIVE_FOCUS_ROWS: ReadonlySet<string> = new Set([
  'list.next.j',
  'list.prev.k',
  'list.next.arrow',
  'list.prev.arrow',
  'list.open',
  'list.launch',
  'board.colPrev.arrow',
  'board.colNext.arrow',
  'board.movePrev',
  'board.moveNext',
]);

/** Rows that restate another row (Esc on a modal, Mod+K inside a field). */
const DUPLICATE_ROWS: ReadonlySet<string> = new Set(['modal.close', 'text.palette', 'board.colPrev.h', 'board.colNext.l']);

function platformOf(): Platform {
  return typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform) ? 'mac' : 'other';
}

/** `Mod+Alt+W` → `⌘ ⌥ W` on a Mac, `Ctrl Alt W` elsewhere; `n t` → `n` `t`. */
export function keyCaps(keys: string, platform: Platform): string[] {
  return keys.split(' ').flatMap((part) =>
    part.length > 1 && part.includes('+')
      ? part.split('+').map((cap) =>
          cap === 'Mod' ? (platform === 'mac' ? '⌘' : 'Ctrl') : cap === 'Alt' && platform === 'mac' ? '⌥' : cap,
        )
      : [part],
  );
}

export function helpRows(platform: Platform): { group: string; rows: Binding[] }[] {
  const shown = BINDINGS.filter(
    (b) =>
      isAdvertised(b, platform) &&
      !DUPLICATE_ROWS.has(b.id) &&
      // The launch card answers its own keys, so all of its rows are live.
      (b.layer !== 'focus' || LIVE_FOCUS_ROWS.has(b.id) || bindingGroup(b) === 'Launch'),
  );
  return BINDING_GROUPS.map((group) => ({ group, rows: shown.filter((b) => bindingGroup(b) === group) })).filter(
    (section) => section.rows.length > 0,
  );
}

const GROUP_NOTE: Partial<Record<string, string>> = {
  Focus: 'Single-key shortcuts never fire while you type. Leave the field or terminal first.',
  Launch: 'On the New session screen (n s). Esc leaves the prompt; the letters then work on the card.',
  Lists: 'l l focuses the list on the left, as it is; l plus a letter switches it to that kind first; l plus a digit, to that pinned kind on the rail.',
};

export function ShortcutsOverlay({ open, onClose }: { open: boolean; onClose: () => void }) {
  const [query, setQuery] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);
  const platform = useMemo(platformOf, []);
  const sections = useMemo(() => helpRows(platform), [platform]);

  useEffect(() => {
    if (!open) return;
    setQuery('');
    inputRef.current?.focus();
  }, [open]);

  if (!open) return null;
  const q = query.trim().toLowerCase();
  const visible = sections
    .map((section) => ({
      ...section,
      rows: q
        ? section.rows.filter((b) => b.label.toLowerCase().includes(q) || b.keys.toLowerCase().includes(q))
        : section.rows,
    }))
    .filter((section) => section.rows.length > 0);

  return (
    <div className="pal-scrim" data-testid="shortcuts-scrim" onMouseDown={onClose}>
      <div
        className="pal kbh"
        role="dialog"
        aria-modal="true"
        aria-label="Keyboard shortcuts"
        data-testid="shortcuts-overlay"
        onMouseDown={(e) => e.stopPropagation()}
        onKeyDown={(e) => {
          if (e.key !== 'Escape') return;
          e.preventDefault();
          e.stopPropagation(); // Esc closes THIS surface only
          onClose();
        }}
      >
        <div className="pal__input-row">
          <span className="pal__icon" aria-hidden>
            ⌨
          </span>
          <input
            ref={inputRef}
            className="pal__input"
            value={query}
            placeholder="Keyboard shortcuts — filter…"
            aria-label="Filter keyboard shortcuts"
            onChange={(e) => setQuery(e.target.value)}
          />
          <kbd className="pal__esc">esc</kbd>
        </div>
        <div className="kbh__body">
          {visible.length === 0 ? <p className="pal__empty">No shortcut matches “{query}”.</p> : null}
          {visible.map((section) => (
            <section key={section.group} className="kbh__section" aria-label={section.group}>
              <div className="pal__group">{section.group.toUpperCase()}</div>
              {GROUP_NOTE[section.group] && !q ? <p className="kbh__note">{GROUP_NOTE[section.group]}</p> : null}
              <ul className="kbh__list">
                {section.rows.map((b) => (
                  <li key={b.id} className="kbh__row" data-testid="shortcut-row" data-binding={b.id}>
                    <span className="kbh__label">{b.label}</span>
                    <span className="kbh__keys">
                      {keyCaps(b.keys, platform).map((cap, i) => (
                        <kbd key={i} className="kbh__kbd">
                          {cap}
                        </kbd>
                      ))}
                    </span>
                  </li>
                ))}
              </ul>
            </section>
          ))}
        </div>
      </div>
    </div>
  );
}
