import { useCallback, useRef, useState, type ReactNode } from 'react';

import { KindIcon, getKind, resolveAction, type ActionRef } from '../domain';
import { useDismissable } from './useDismissable';
import './list-root-header.css';

/** One switcher/cell entry: a kind, its plural label, and its singular. */
export interface ListRootOption {
  kind: string;
  label: string;
  single: string;
}

/**
 * THE ACTION A KIND IS BORN BY, or undefined when the generic create makes it.
 *
 * Registry data, never a kind literal (§15.2): `list.quickStart` is the field
 * that already said "this kind's birth is a verb, not a create" — it declared
 * `start-terminal` on work_session, because a session is not authored, it is
 * STARTED. It used to draw a button in the panel header one row below this
 * bar; the header's ＋ half is where the reader looks for "make me one of
 * these", so the verb moved into it and the duplicate row went away.
 *
 * Exported because the HOST performs it. This module can name the verb but
 * must not dispatch it: `useSessionStart` owns the space, the project and the
 * command surface a terminal needs, and none of those belong to a header.
 */
export function rootBirthAction(kind: string): ActionRef | undefined {
  return getKind(kind).list.quickStart;
}

/** What a kind's ＋ half WEARS and says — a glyph, a name, and a promise. */
interface BirthVerb {
  glyph: string;
  /** The `aria-label`: "New task", "Terminal". */
  label: string;
  /** The title: what pressing it will actually do. */
  promise: string;
}

function birthVerbFor(option: ListRootOption): BirthVerb {
  const action = rootBirthAction(option.kind);
  if (action) {
    const def = resolveAction(action);
    return {
      glyph: def.icon,
      label: def.label,
      promise: `Start a ${def.label.toLowerCase()} and open it — ${option.label.toLowerCase()} are started, not authored`,
    };
  }
  return {
    glyph: '+',
    label: `New ${option.single.toLowerCase()}`,
    /* D3 generalized: the entity exists the instant you press, and the SAVE
       flow is what names it. The title says so rather than promising a form. */
    promise: `Create an Untitled ${option.single.toLowerCase()} and open it — type its name there`,
  };
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
  /** The caret's menu. Picking a kind's LABEL only ever switches (R5) — its ＋ creates. */
  options?: readonly ListRootOption[] | undefined;
  /**
   * The menu's per-row ＋ (user ruling 2026-08-19): every kind in the drop-down
   * carries the same birth verb the cell does, for ITS kind, so making a doc
   * costs one press from a list of tasks instead of switch-then-create.
   *
   * This NARROWS R5, it does not reverse it: picking a kind still only ever
   * switches, because the ＋ is a separate control from the row's label. What
   * changed is that the menu now has two halves per row, exactly as the cell
   * outside it has always had two halves.
   *
   * ABSENT ⇒ the rows draw no ＋ at all. That is the one place this header
   * hides a verb rather than refusing it: an unwired host would otherwise put
   * a dead control on FOURTEEN rows of a popover, and fourteen copies of the
   * same reason is noise, not honesty. The cell's own ＋ still refuses out
   * loud, and it says the same thing once.
   */
  onCreateKind?: ((kind: string) => void) | undefined;
  /** Why a given kind's menu ＋ is refused, or null. Consulted per row. */
  createKindUnavailable?: ((kind: string) => { cause: string; remedy: string } | null) | undefined;
  /** Which option reads as current. Not always `cell.kind`: Home parks the last kind here while sitting on Chats. */
  currentKind?: string | undefined;
  onPickKind: (kind: string) => void;
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

  const { chats, cell, onCreate, createUnavailable, options, onCreateKind } = props;
  const current = props.currentKind ?? cell?.kind;
  /* The cell wears its kind's OWN birth verb, so the sessions cell shows the
     terminal glyph rather than a ＋ that would promise an authored entity. */
  const cellBirth = cell ? birthVerbFor(cell) : null;

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
              <span aria-hidden>+</span>
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
              aria-label={cellBirth!.label}
              aria-disabled={onCreate ? undefined : 'true'}
              title={
                onCreate
                  ? cellBirth!.promise
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
              <span aria-hidden>{cellBirth!.glyph}</span>
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
                  <li key={option.kind} className="tch-rootitem">
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
                    {onCreateKind ? (
                      <RowBirth
                        option={option}
                        refusal={props.createKindUnavailable?.(option.kind) ?? null}
                        onBirth={() => {
                          setMenuOpen(false);
                          onCreateKind(option.kind);
                          /* The cell's ＋ lands the column on its own root
                             (D10) and this is the same verb, so it does too —
                             pressing ＋ on Docs and staying on Tasks would put
                             the new doc in a list that cannot show it. */
                          props.onPickKind(option.kind);
                        }}
                      />
                    ) : null}
                  </li>
                ))}
              </ul>
            ) : null}
          </div>
        ) : null}
      </div>
    </div>
  );
}

/**
 * One menu row's birth half.
 *
 * NOT `role="menuitem"`: the row's LABEL is the menu item — it is what the
 * menu is for, and what a screen reader arrows through. This is a second
 * control beside it, exactly as the cell outside has a ＋ beside its tab, and
 * announcing two menu items per kind would make the menu read as twenty-eight
 * choices when it offers fourteen.
 *
 * REFUSED RATHER THAN HIDDEN, per row: a kind that cannot be born here says
 * why, because "the ＋ is missing from this one row" is not a sentence anyone
 * can act on. The hiding decision is made one level up, on the whole menu —
 * see `onCreateKind`.
 */
function RowBirth({
  option,
  refusal,
  onBirth,
}: {
  option: ListRootOption;
  refusal: { cause: string; remedy: string } | null;
  onBirth: () => void;
}) {
  const birth = birthVerbFor(option);
  return (
    <button
      type="button"
      className="tch-rootopt__birth"
      aria-label={birth.label}
      aria-disabled={refusal ? 'true' : undefined}
      title={refusal ? `${refusal.cause} — ${refusal.remedy}` : birth.promise}
      onClick={refusal ? (event) => event.preventDefault() : onBirth}
    >
      <span aria-hidden>{birth.glyph}</span>
    </button>
  );
}
