import { useCallback, useRef, useState, type ReactNode } from 'react';

import { KindIcon, getKind, resolveAction, type ActionRef } from '../domain';
import { openEntityHelp } from '../entity-help/entityHelpStore';
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

/** A composed dispatcher: what it can perform, and the door to perform it. */
export interface BirthDispatcher {
  onAction: (ref: ActionRef, entityId: string) => void;
  wiredActions: readonly ActionRef[];
}

/**
 * THE ＋ HALF'S VERB ARM, ANSWERED ONCE FOR EVERY HOST.
 *
 * Returns null when the kind has no birth verb — the caller falls through to
 * its own generic-create arm, which differs per host (where the newborn
 * lands) and so cannot live here.
 *
 * IT GATES ON `wiredActions`, NOT ON THE PRESENCE OF A DISPATCHER, and that
 * distinction is the whole reason this function exists. Both hosts used to ask
 * whether `useSessionStart.onAction` was defined and then hand it whatever verb
 * the registry named. That hook's dispatch is a switch — `start-terminal`,
 * then `default: return` — so a kind whose verb it does not know passed the
 * gate and did NOTHING on click: no navigation, no refusal, no error.
 *
 * `chat` is the kind that exposed it (`quickStart: 'chat-about'`, performed by
 * `useChatAbout`), and it was only reachable once the Chats row was promoted
 * out of the rail's "More" group. `container` (`new-container`,
 * `useNewContainerSheet`) reached the same arm from another lane within a day.
 * Both hosts already COMPOSED their dispatchers for their lists; only this arm
 * reached past the composition.
 *
 * AND `onAction != null` IS NOT THE FIX. Routing through the composed
 * dispatcher while still gating on its presence looks right and is worse:
 * `composeListActions` ALWAYS returns an `onAction` (it closes over the live
 * parts and finds among them), so that check is a constant `true` and the
 * refusal branch becomes unreachable — every unperformable verb draws an
 * enabled control, including the ones that used to refuse honestly. Only
 * `wiredActions` answers the question.
 *
 * Duplicated in two hosts before, with the same defect in both, which is the
 * other half of why it is one function now.
 */
export function rootBirthDispatch(
  kind: string,
  dispatcher: BirthDispatcher,
): { refusal: { cause: string; remedy: string } | null; perform: () => void } | null {
  const action = rootBirthAction(kind);
  if (!action) return null;
  if (dispatcher.wiredActions.includes(action)) {
    return { refusal: null, perform: () => dispatcher.onAction(action, '') };
  }
  return {
    refusal: {
      cause: `Starting ${getKind(kind).labelPlural.toLowerCase()} isn’t wired here`,
      remedy: 'this surface was mounted without a command executor',
    },
    perform: () => undefined,
  };
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
    glyph: '＋',
    label: `New ${option.single.toLowerCase()}`,
    /* D3 generalized: the entity exists the instant you press, and the SAVE
       flow is what names it. The title says so rather than promising a form. */
    promise: `Create an Untitled ${option.single.toLowerCase()} and open it — type its name there`,
  };
}

export interface ListRootHeaderProps {
  /** `aria-label` for the tablist — names WHICH roots, so it differs per host. */
  rootsLabel: string;
  /**
   * THE QUICK-CREATE ICONS (task 01a0df28): one icon per kind, drawn BEFORE
   * the tablist. They replaced the `[Chats ＋]` cell once a chat became an
   * entity with its own list (the `chat` kind in the menu). Absent or empty ⇒
   * no icons.
   */
  quickKinds?: readonly ListRootOption[] | undefined;
  /**
   * An icon's press. ITS OWN PROP, not `onCreateKind`, because the two have
   * opposite absence rules: an absent `onCreateKind` HIDES fourteen menu
   * controls, while three icons refuse out loud — and a host can perform some
   * icons without a generic create (Home opens its own composer for a chat).
   * Absent ⇒ every icon refuses with the not-wired reason.
   */
  onQuickBirth?: ((kind: string) => void) | undefined;
  /** Why a given icon is refused, or null. Consulted per icon. */
  quickBirthUnavailable?: ((kind: string) => { cause: string; remedy: string } | null) | undefined;
  /** The kind cell. Absent only while a host has no kind to name yet. */
  cell?: ListRootOption | undefined;
  /** Whether the kind cell is the selected root. */
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
  /** Which option reads as current. Defaults to `cell.kind`. */
  currentKind?: string | undefined;
  onPickKind: (kind: string) => void;
  /**
   * THE (?) MARK'S PRESS (Entity Help, form 01a0e7d3). Beside the kind name in
   * the cell and on every menu row. Absent ⇒ the default: open that kind's
   * help in the store the hosts' `EntityHelpOverlay` reads. Help is client
   * data with no executor behind it, so this is the one control on the bar
   * that is never refused and never hidden.
   */
  onHelp?: ((kind: string, from: HTMLElement | null) => void) | undefined;
}

/**
 * THE ROOT HEADER — `[☐ ❝ ▮] [◫ Kind ＋ ▾]`: the quick-create icons, then
 * the kind cell. Extracted from `ChatHomeScreen` (task 01a0102f) so the Work tab's
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
  /* THE CARET OUTLIVES THE MENU. A row's (?) closes the menu as it opens
     help, which unmounts the row — so focus cannot come back to it. The
     caret is the control that stays, and it is the one a keyboard user
     pressed to reach the row, so it is where focus returns (review M1). */
  const caretRef = useRef<HTMLButtonElement>(null);
  useDismissable(
    menuOpen,
    menuRef,
    useCallback(() => setMenuOpen(false), []),
  );

  const { quickKinds, onQuickBirth, cell, onCreate, createUnavailable, options, onCreateKind } = props;
  const current = props.currentKind ?? cell?.kind;
  /* The cell wears its kind's OWN birth verb, so the sessions cell shows the
     terminal glyph rather than a ＋ that would promise an authored entity. */
  const cellBirth = cell ? birthVerbFor(cell) : null;

  return (
    <div className="tch-rootbar">
      {quickKinds && quickKinds.length > 0 ? (
        /* OUTSIDE THE TABLIST for the switcher's reason: these create, they do
           not select a root, and a non-tab inside `role="tablist"` is a lie to
           the a11y tree. */
        <div className="tch-quick" role="group" aria-label="Create">
          {quickKinds.map((option) => (
            <QuickBirth
              key={option.kind}
              option={option}
              refusal={
                onQuickBirth
                  ? (props.quickBirthUnavailable?.(option.kind) ?? null)
                  : {
                      cause: `Creating ${option.label.toLowerCase()} isn’t wired on this surface`,
                      remedy: 'this surface was mounted without a create flow',
                    }
              }
              onBirth={() => {
                onQuickBirth?.(option.kind);
                /* D10, the same as the cell's ＋ and a menu row's: the column
                   lands on the newborn's own root, or it lands in a list that
                   cannot show it. */
                props.onPickKind(option.kind);
              }}
            />
          ))}
        </div>
      ) : null}
      <div className="tch-roots" role="tablist" aria-label={props.rootsLabel}>
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
            <HelpMark option={cell} onHelp={props.onHelp} />
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
              {/* THE GLYPH CARRIES ITS WORD. A bare ＋ says that something can
                  be made and never what — the one thing a user comes to this
                  bar to do was the only control on it with no label. The
                  accessible name is unchanged (`cellBirth.label`), so the three
                  suites that navigate by it are unaffected; `aria-hidden` on
                  both spans keeps the button a single named node rather than
                  reading its glyph aloud beside its name. */}
              <span aria-hidden>{cellBirth!.glyph}</span>
              <span className="tch-rootcell__plusword" aria-hidden>New</span>
            </button>
            {options && options.length > 0 ? (
              /* THE SECOND HALF OF A SPLIT BUTTON. It sat flush against the
                 create action with no divider and a 17×26 hit area — under a
                 quarter of the touch floor — so a mis-tap on the kind cell
                 CREATED AN ENTITY when it meant to open a menu. The divider
                 and the wider target are in `list-root-header.css`; what is
                 added here is what the markup lacked. The accessible name is
                 VERBATIM — `home-roots.test.tsx` and `gate.test.tsx` both
                 navigate by it. */
              <button
                type="button"
                ref={caretRef}
                className="tch-rootcell__caret"
                aria-label="Choose which list to show"
                title="Choose which list to show"
                aria-haspopup="menu"
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
                    <HelpMark
                      option={option}
                      row
                      onHelp={(kind) => {
                        setMenuOpen(false);
                        (props.onHelp ?? openEntityHelp)(kind, caretRef.current);
                      }}
                    />
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
 * THE (?) MARK — "Help for Tasks", beside the kind name in the cell and on
 * every row of the kind menu.
 *
 * NOT a `role="tab"` and NOT a `role="menuitem"`, for the reasons the ＋ and
 * the caret are neither: the tablist is the root SELECTION and the menu is
 * the root LIST, and a help control is not a root. It sits beside them as a
 * plain button with an accessible name that says the kind, so a screen
 * reader hears "Help for Sessions" and not a bare question mark.
 *
 * Its accessible name is the only new name on this bar; every name that was
 * here before is VERBATIM (`home-roots.test.tsx`, `gate.test.tsx` navigate
 * by them).
 */
function HelpMark({
  option,
  row = false,
  onHelp,
}: {
  option: ListRootOption;
  row?: boolean;
  onHelp?: ((kind: string, from: HTMLElement | null) => void) | undefined;
}) {
  return (
    <button
      type="button"
      className={row ? 'tch-rootopt__help' : 'tch-rootcell__help'}
      aria-label={`Help for ${option.label}`}
      title={`Help for ${option.label.toLowerCase()} — what they are, the commands, the relations`}
      data-help-kind={option.kind}
      onClick={(event) => (onHelp ?? openEntityHelp)(option.kind, event.currentTarget)}
    >
      <span aria-hidden>?</span>
    </button>
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

/**
 * One quick-create icon. The icon is the KIND's (a task, a chat, a terminal),
 * not the verb's glyph: three verb glyphs side by side say "three ways to
 * act", three kind icons say "one of these". The accessible name is the verb's
 * noun (`New task`, `New chat`, `New terminal`), and it is refused with a reason
 * rather than hidden, per the rule the cell's ＋ follows.
 */
function QuickBirth({
  option,
  refusal,
  onBirth,
}: {
  option: ListRootOption;
  refusal: { cause: string; remedy: string } | null;
  onBirth: () => void;
}) {
  const action = rootBirthAction(option.kind);
  /* "New terminal", "New chat", "New task" — the verb's noun where the kind
     is born by a verb, so the sessions icon names what actually opens. */
  const label = action
    ? `New ${resolveAction(action).label.toLowerCase()}`
    : birthVerbFor(option).label;
  return (
    <button
      type="button"
      className="tch-quick__btn"
      aria-label={label}
      aria-disabled={refusal ? 'true' : undefined}
      title={refusal ? `${refusal.cause} — ${refusal.remedy}` : label}
      data-quick-kind={option.kind}
      onClick={refusal ? (event) => event.preventDefault() : onBirth}
    >
      <KindIcon kind={option.kind} />
    </button>
  );
}
