import { useCallback, useRef, useState, type ReactNode } from 'react';

import { KindIcon } from '../domain';
import { useDismissable } from './useDismissable';
import './list-root-header.css';

/** One switcher/cell entry: a kind, its plural label, and its singular. */
export interface ListRootOption {
  kind: string;
  label: string;
  single: string;
}

/**
 * The Chats cell — Home's first root, and the reason this bar is a `tablist`
 * rather than a lone kind button. It is OPTIONAL because it is not portable:
 * Chats hosts no list, it swaps the surface's CENTRE to the conversation
 * composer. A surface whose centre cannot become a composer (the Work tab,
 * whose centre is the ink stage) must omit it rather than draw a cell that
 * would have nowhere to land.
 */
export interface ListRootChatsCell {
  active: boolean;
  onSelect: () => void;
  onCreate: () => void;
}

export interface ListRootHeaderProps {
  /** `aria-label` for the tablist — names WHICH roots, so it differs per host. */
  rootsLabel: string;
  chats?: ListRootChatsCell | undefined;
  /** The kind cell. Absent only while a host has no kind to name yet. */
  cell?: ListRootOption | undefined;
  /** Whether the kind cell is the selected root. Always true where `chats` is absent. */
  cellActive: boolean;
  /** The label half: SWITCH to this cell's kind. */
  onSelectCell: (kind: string) => void;
  /**
   * The ＋ half: create an Untitled entity, open it, focus its title (D3
   * generalized). Absent means the host cannot create here — the button stays
   * VISIBLE and explains itself via `createUnavailable`, per the honesty rule
   * that a refused verb is told, never hidden.
   */
  onCreate?: (() => void) | undefined;
  createUnavailable?: { cause: string; remedy: string } | null;
  /** The caret's menu. R5: picking a kind only ever SWITCHES — it never creates. */
  options?: readonly ListRootOption[] | undefined;
  /** Which option reads as current. Not always `cell.kind`: Home parks the last kind here while sitting on Chats. */
  currentKind?: string | undefined;
  onPickKind: (kind: string) => void;
  /** The hosted list's layout switcher, pinned right. Outside the tablist by construction — see below. */
  aside?: ReactNode;
}

/**
 * THE ROOT HEADER — `[Chats ＋] [◫ Kind ＋ ▾]` plus the hosted list's layout
 * switcher. Extracted from `ChatHomeScreen` (task 01a0102f) so the Work tab's
 * two columns draw the SAME bar Home draws instead of `EntityListPanel`'s own
 * `KindSelector`. Both hosts pass `selectorSlot="host"` to the panel, which is
 * what retires that row: the panel's header restated this one's kind and spent
 * 34.9px doing it.
 *
 * THE SWITCHER SITS OUTSIDE THE TABLIST, never in it — the tablist is the root
 * SELECTION, so every child of it must be a tab, and a layout switcher is not a
 * root. Nesting it would make `role="tablist"` a lie to the a11y tree.
 *
 * Labels only, no counts (D16). The total and live counts `KindSelector` draws
 * are deliberately absent here; a host that wants them must draw them itself.
 */
export function ListRootHeader(props: ListRootHeaderProps) {
  const [menuOpen, setMenuOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);
  useDismissable(
    menuOpen,
    menuRef,
    useCallback(() => setMenuOpen(false), []),
  );

  const { chats, cell, onCreate, createUnavailable, options } = props;
  const current = props.currentKind ?? cell?.kind;

  return (
    <div className="tch-rootbar">
      <div className="tch-roots" role="tablist" aria-label={props.rootsLabel}>
        {chats ? (
          <div className={`tch-rootcell${chats.active ? ' tch-rootcell--active' : ''}`}>
            <button
              type="button"
              role="tab"
              aria-selected={chats.active}
              className="tch-rootcell__label"
              onClick={chats.onSelect}
            >
              Chats
            </button>
            <button
              type="button"
              className="tch-rootcell__plus"
              aria-label="New chat"
              title="Start a new conversation"
              onClick={chats.onCreate}
            >
              <span aria-hidden>＋</span>
            </button>
          </div>
        ) : null}
        {cell ? (
          <div
            className={`tch-rootcell tch-rootcell--kind${props.cellActive ? ' tch-rootcell--active' : ''}`}
            ref={menuRef}
          >
            <button
              type="button"
              role="tab"
              aria-selected={props.cellActive}
              className="tch-rootcell__label"
              title={`List ${cell.label.toLowerCase()}`}
              onClick={() => props.onSelectCell(cell.kind)}
            >
              <span className="tch-rootcell__glyph" aria-hidden>
                <KindIcon kind={cell.kind} />
              </span>
              {cell.label}
            </button>
            <button
              type="button"
              className="tch-rootcell__plus"
              aria-label={`New ${cell.single.toLowerCase()}`}
              aria-disabled={onCreate ? undefined : 'true'}
              title={
                onCreate
                  ? `Create an Untitled ${cell.single.toLowerCase()} and open it — type its name there`
                  : createUnavailable
                    ? `${createUnavailable.cause} — ${createUnavailable.remedy}`
                    : `Creating ${cell.label.toLowerCase()} isn’t wired on this surface`
              }
              onClick={
                onCreate
                  ? () => {
                      /* D3 generalized: create immediately — the host's create
                         flow makes the entity, selects it into the detail
                         panel (title focused) and, per D10, we land on its
                         root. */
                      onCreate();
                      props.onSelectCell(cell.kind);
                    }
                  : (event) => event.preventDefault()
              }
            >
              <span aria-hidden>＋</span>
            </button>
            {options && options.length > 0 ? (
              <button
                type="button"
                className="tch-rootcell__caret"
                aria-label="Choose which list to show"
                aria-expanded={menuOpen}
                onClick={() => setMenuOpen((open) => !open)}
              >
                <span aria-hidden>▾</span>
              </button>
            ) : null}
            {menuOpen && options ? (
              <ul className="tch-rootmenu" role="menu" aria-label="Entity lists">
                {options.map((option) => (
                  <li key={option.kind}>
                    <button
                      type="button"
                      role="menuitem"
                      className={
                        option.kind === current ? 'tch-rootopt tch-rootopt--current' : 'tch-rootopt'
                      }
                      onClick={() => {
                        setMenuOpen(false);
                        /* R5: picking a kind SWITCHES the root. Never creates. */
                        props.onPickKind(option.kind);
                      }}
                    >
                      <KindIcon kind={option.kind} />
                      {option.label}
                    </button>
                  </li>
                ))}
              </ul>
            ) : null}
          </div>
        ) : null}
      </div>
      {props.aside}
    </div>
  );
}
