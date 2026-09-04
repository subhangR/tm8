/**
 * T2-3 — THE MENU EDITOR (oracle L275–L391), with its live preview and both of
 * the states the oracle draws beside it.
 *
 * The oracle's own note (L388) is the design constraint: "Editor speaks rail
 * grammar: the three row types (group / plain / caret view) are the only
 * things it can create — so nothing expressible in the editor can break T1-1's
 * rendering rules. Icons come from the ref's kind or view automatically; only
 * groups are free-text." `menu-edit.ts` is that sentence made structural, and
 * this component is its surface.
 *
 * WHAT WORKS, FOR REAL: load (through the port's C-4 fallback), reorder by
 * keyboard and by drag, rename a group in place with ⏎/esc, remove any row,
 * add a group / view ref / kind ref from registry-derived pickers, the 8-child
 * cap stated on its own disabled control, discard, and a live preview that
 * re-renders every keystroke in the rail's own grammar.
 *
 * WHAT CANNOT: Save. `data/seam.ts` records the ruling verbatim —
 * `spaces.menu.update` "stays OUT of this seam until their phase". So Save is
 * disabled-with-reason, ALWAYS, and under a version lock the same control
 * simply carries a different reason. The oracle draws a second disabled Save
 * inside the lock panel (L383); this does not, because two refusals of one verb
 * on one screen read as two verbs.
 *
 * DRAG: implemented with HTML5 dnd AND with keyboard (alt+↑/↓ on the grip),
 * because a reorder that only exists under a mouse is a control a keyboard
 * user can see and never use — the same argument that makes the refusal
 * treatment focusable.
 *
 * AND WITH EXPLICIT MOVE BUTTONS, because neither of those two reaches a finger:
 * HTML5 drag-and-drop fires NO events from a touch gesture, and alt+arrow needs
 * an alt key. Reordering this menu was therefore not awkward on a touch device,
 * it was impossible — on a control that looked exactly as available as it does
 * under a mouse. See `Grip` for why buttons rather than a touch-drag, and why
 * they are revealed by `(pointer: coarse)` rather than by the mobile shell.
 *
 * LAYOUT lives in `menu-editor.css`, next door, and is written against
 * SECTION-CONTRACT.md. Three things about it are load-bearing and easy to undo
 * by accident:
 *
 *   · `SettingsShell` ALREADY wraps this in a `SectionFrame` (with
 *     `measure={false}`, deliberately — capping an author-plus-preview pair at
 *     the reading measure stacks them on a screen with room for both). So this
 *     component must NOT draw a head of its own. It used to, and the section
 *     rendered "Menu" twice.
 *   · §3: the preview is the ONE internally scrolling pane, and it is bounded
 *     by `max-height`. Making it `flex: 1` inside the section scroller puts it
 *     back to content height, where `overflow: auto` never engages.
 *   · The editor's rows deliberately do NOT scroll. The section scroller owns
 *     that overflow; a second scroller nested in it clips instead of scrolls.
 */
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import type { MenuGroup, MenuItem, MenuLeaf, MenuViewRef } from '@tm8/contract';
import './menu-editor.css';
import { CUSTOM_KIND_FALLBACK, KindIcon, getKind } from '../domain';
import { VectorIcon } from '../kit';
import { VIEW_PRESENTATION, type ResolvedMenu } from '../shell/menu-resolve';
import { DisabledAction, DisabledIconControl } from '../panels';
import {
  MENU_CAPS,
  addChild,
  addGroup,
  addItem,
  availableKindRefs,
  availableViewRefs,
  childCapacity,
  draftConfig,
  draftIssue,
  groupCapacity,
  isDirty,
  moveChild,
  moveGroup,
  moveItem,
  removeChild,
  removeGroup,
  removeItem,
  renameGroup,
  startDraft,
  type MenuDraft,
} from './menu-edit';
import {
  MENU_GROUP_CAP_REASON,
  MENU_NO_FREE_KIND_REF,
  MENU_NO_FREE_VIEW_REF,
  MENU_RELOAD_UNAVAILABLE,
  MENU_SAVE_UNAVAILABLE,
  MENU_SAVE_VERSION_LOCKED,
  menuChildCapReason,
} from './reasons';
import { SectionAbsent } from './SectionFrame';

export interface MenuEditorProps {
  /** What the port loaded — config plus WHY it is that config. */
  menu: ResolvedMenu;
  /** Space label for the header's `space · atelier · v12` line (oracle L288). */
  spaceName?: string;
  /**
   * A revision seen on the space that is NEWER than the loaded one. Drives the
   * conflict panel. The host supplies it from a `menu.updated` event; absent
   * means no conflict is known — never means "no conflict exists".
   */
  conflictRevision?: number | null;
  /** Who saved first, when known. */
  conflictBy?: string | null;
  /**
   * The menu declares a schemaVersion this build cannot edit. Read-only.
   * Derived by the host, not guessed here.
   */
  versionLocked?: boolean;
}

/** The three row types the editor can express — the oracle's own vocabulary. */
type RowKind = 'group' | 'item' | 'child';

export function MenuEditor({
  menu,
  spaceName,
  conflictRevision = null,
  conflictBy = null,
  versionLocked = false,
}: MenuEditorProps) {
  const [draft, setDraft] = useState<MenuDraft>(() => startDraft(menu.config));
  const [renaming, setRenaming] = useState<string | null>(null);
  const [renameText, setRenameText] = useState('');
  const [picker, setPicker] = useState<null | { kind: 'view' | 'kind' | 'group'; groupId?: string }>(null);
  const [dragging, setDragging] = useState<null | { row: RowKind; groupId?: string; index: number }>(null);
  const renameRef = useRef<HTMLInputElement | null>(null);

  // A freshly loaded menu replaces the draft. Editing then reloading and
  // silently keeping the old draft is how an editor saves a stale tree.
  useEffect(() => {
    setDraft(startDraft(menu.config));
  }, [menu.config]);

  useEffect(() => {
    if (renaming) renameRef.current?.focus();
  }, [renaming]);

  const config = draftConfig(draft);
  const issue = draftIssue(draft);
  const dirty = isDirty(draft);
  const groupCap = groupCapacity(draft);
  const freeViews = useMemo(() => availableViewRefs(draft), [draft]);
  const freeKinds = useMemo(() => availableKindRefs(draft), [draft]);

  const commitRename = useCallback(() => {
    if (renaming) setDraft((d) => renameGroup(d, renaming, renameText));
    setRenaming(null);
  }, [renaming, renameText]);

  const editable = !versionLocked;
  const conflicted = conflictRevision !== null && conflictRevision > config.revision;
  const rowCount = config.groups.reduce((n, g) => n + g.items.length, 0);

  return (
    <div className="set-menu">
      {/* ---------------------------------------------------------------- */}
      {/* alerts — full width, above the split, because every one of them is */}
      {/* about the whole section rather than about one of its columns.      */}
      {/* They used to sit in a third `.set-menu__states` column that was    */}
      {/* measured EMPTY at 433x387 on a 900px window: a third of the card   */}
      {/* reserved for nothing, on the size where space was scarcest.        */}
      {/* ---------------------------------------------------------------- */}
      {conflicted || versionLocked || issue ? (
        <div className="set-menu__alerts">
          {conflicted ? (
            <div className="set-state" data-testid="menu-conflict">
              <span className="set-eyebrow">Conflict — someone saved first</span>
              <div className="set-state__banner set-state__banner--info">
                <span className="set-state__glyph" aria-hidden>
                  ◬
                </span>
                <div className="set-state__text">
                  <span className="set-state__title">
                    Menu changed by {conflictBy ?? 'someone else'} just now
                  </span>
                  <span className="set-state__body">
                    This editor holds v{config.revision}; the space is on v{conflictRevision}.
                    Reload to edit — your unsaved reorder will be lost.
                  </span>
                </div>
                <DisabledIconControl
                  label={`reload v${conflictRevision}`}
                  reason={MENU_RELOAD_UNAVAILABLE}
                >
                  <span className="set-state__action">Reload v{conflictRevision}</span>
                </DisabledIconControl>
              </div>
              <span className="set-state__foot">
                last-write-wins everywhere else; the editor is the one surface that warns before
                losing work
              </span>
            </div>
          ) : null}

          {versionLocked ? (
            <div className="set-state" data-testid="menu-version-lock">
              <span className="set-eyebrow">Version-locked — newer schema</span>
              <div className="set-state__banner set-state__banner--warn">
                <span className="set-state__glyph" aria-hidden>
                  ⚿
                </span>
                <div className="set-state__text">
                  <span className="set-state__title">Edited by a newer tm8</span>
                  <span className="set-state__body">
                    This menu uses features this build doesn’t know. Read-only here — the rail
                    still renders what it understands, and unknown refs fall back to ◇.
                  </span>
                </div>
              </div>
              {/* The second `Save menu` this block used to draw is gone: the
                  toolbar's already reports MENU_SAVE_VERSION_LOCKED under a
                  lock, and two refusals of one verb read as two verbs. */}
            </div>
          ) : null}

          {issue ? (
            <SectionAbsent
              head="The rail would refuse this menu."
              why={issue}
              testId="menu-issue"
            />
          ) : null}
        </div>
      ) : null}

      {/* ---------------------------------------------------------------- */}
      {/* the toolbar. NOT a second head — `SettingsShell` already wraps      */}
      {/* this component in a `SectionFrame` whose head reads "Menu" at 19px, */}
      {/* and this file drew its own "Menu" at 16px directly underneath it.   */}
      {/* ---------------------------------------------------------------- */}
      <div className="set-menu__bar">
        <span className="set-menu__ident">
          <span className="set-menu__version">
            {['space', spaceName, `v${config.revision}`].filter(Boolean).join(' · ')}
          </span>
          <span className="set-menu__count">
            {config.groups.length} groups · {rowCount} rows
          </span>
        </span>
        <div className="set-section__grow" />
        {dirty ? <span className="set-menu__dirty">unsaved</span> : null}
        <button
          type="button"
          className="set-ghost"
          onClick={() => setDraft(startDraft(menu.config))}
          disabled={!dirty}
          title={dirty ? 'discard your unsaved edits' : 'nothing to discard'}
        >
          discard
        </button>
      </div>
      {/* `DisabledAction` is a control PLUS a prose caption. In the old flex
          head that caption rendered as a four-line paragraph wedged between
          `discard` and the card edge, and drove the header to ~120px tall. A
          caption gets its own line, and a measure. */}
      <div className="set-menu__save">
        <DisabledAction
          reason={versionLocked ? MENU_SAVE_VERSION_LOCKED : MENU_SAVE_UNAVAILABLE}
          label="save menu"
        >
          Save menu
        </DisabledAction>
      </div>

      <div className="set-menu__cols">
        {/* ---------------------------------------------------------------- */}
        {/* the editor                                                        */}
        {/* ---------------------------------------------------------------- */}
        <div className="set-menu__editor set-panel">
          <div className="set-menu__rows">
            {config.groups.length === 0 ? (
              <div className="set-menu__empty">
                <SectionAbsent
                  head="This menu has no groups."
                  why="every rail row lives in a group, so there is nothing for the rail to draw — add a group below, then put a view or kind ref in it"
                  testId="menu-empty"
                />
              </div>
            ) : null}
            {config.groups.map((group, gi) => (
              <div className="set-menu__grp" key={group.id}>
                <div
                  className={rowClass('group', dragging, group.id, gi)}
                  draggable={editable}
                  onDragStart={() => setDragging({ row: 'group', index: gi })}
                  onDragEnd={() => setDragging(null)}
                  onDragOver={(e) => e.preventDefault()}
                  onDrop={() => {
                    if (dragging?.row === 'group') setDraft((d) => moveGroup(d, dragging.index, gi));
                    setDragging(null);
                  }}
                  data-testid="menu-group-row"
                >
                  <Grip
                    name={group.label}
                    disabled={!editable}
                    onMove={(delta) => setDraft((d) => moveGroup(d, gi, gi + delta))}
                  />
                  {renaming === group.id ? (
                    <>
                      <input
                        ref={renameRef}
                        className="set-rename"
                        value={renameText}
                        aria-label={`rename ${group.label}`}
                        onChange={(e) => setRenameText(e.target.value)}
                        onBlur={commitRename}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter') commitRename();
                          if (e.key === 'Escape') setRenaming(null);
                        }}
                      />
                      <span className="set-rename__hint">renaming — ⏎ commits · esc cancels</span>
                    </>
                  ) : (
                    <>
                      <span className="set-eyebrow">{group.label}</span>
                      <button
                        type="button"
                        className="set-row__pencil"
                        aria-label={`rename ${group.label}`}
                        disabled={!editable}
                        onClick={() => {
                          setRenameText(group.label);
                          setRenaming(group.id);
                        }}
                      >
                        ✎
                      </button>
                    </>
                  )}
                  <div className="set-section__grow" />
                  <button
                    type="button"
                    className="set-row__x"
                    aria-label={`remove group ${group.label}`}
                    disabled={!editable}
                    onClick={() => setDraft((d) => removeGroup(d, group.id))}
                  >
                    ✕
                  </button>
                </div>

                {group.items.map((item, ii) => (
                  <ItemRows
                    key={item.ref}
                    group={group}
                    item={item}
                    itemIndex={ii}
                    editable={editable}
                    dragging={dragging}
                    setDragging={setDragging}
                    draft={draft}
                    setDraft={setDraft}
                    freeKinds={freeKinds}
                    freeViews={freeViews}
                  />
                ))}
              </div>
            ))}
          </div>

          {/* The three creators are a FOOTER of the editor panel, not a row in
              the list they create into. */}
          <div className="set-add-bar">
              <AddControl
                label="Add view"
                enabled={editable && freeViews.length > 0}
                reason={MENU_NO_FREE_VIEW_REF}
                onClick={() => setPicker({ kind: 'view' })}
              />
              <AddControl
                label="Add kind"
                enabled={editable && freeKinds.length > 0}
                reason={MENU_NO_FREE_KIND_REF}
                onClick={() => setPicker({ kind: 'kind' })}
              />
              <AddControl
                label="Add group"
                enabled={editable && !groupCap.full}
                reason={MENU_GROUP_CAP_REASON(groupCap.used, groupCap.max)}
                onClick={() => setPicker({ kind: 'group' })}
              />
            </div>

            {picker ? (
              <Picker
                picker={picker}
                groups={config.groups}
                freeViews={freeViews}
                freeKinds={freeKinds}
                onCancel={() => setPicker(null)}
                onPickRef={(groupId, leaf) => {
                  setDraft((d) => addItem(d, groupId, leaf));
                  setPicker(null);
                }}
                onNewGroup={(label) => {
                  setDraft((d) => addGroup(d, label));
                  setPicker(null);
                }}
              />
            ) : null}
        </div>

        {/* ---------------------------------------------------------------- */}
        {/* live preview — the rail's grammar (oracle L336–L352).             */}
        {/* SECTION-CONTRACT §3: this is the one internally scrolling pane on  */}
        {/* the section, and it is bounded by `max-height` in menu-editor.css, */}
        {/* not by `flex: 1` inside the section scroller.                      */}
        {/* ---------------------------------------------------------------- */}
        <aside className="set-menu__preview set-panel">
          <div className="set-prev__head">Live preview — as the rail renders it</div>
          <div className="set-prev__body" data-testid="menu-preview">
            {config.groups.length === 0 ? (
              <div className="set-menu__empty">
                <SectionAbsent
                  head="Nothing to render."
                  why="the rail would draw an empty column for this menu"
                  testId="menu-preview-empty"
                />
              </div>
            ) : null}
            {config.groups.map((group) => (
              <div key={group.id}>
                <div className="set-prev__group">{group.label}</div>
                {group.items.map((item) => (
                  <div key={item.ref}>
                    <div className="set-prev__row">
                      <span className="set-prev__glyph" aria-hidden>
                        {glyphOf(item)}
                      </span>
                      <span className="set-prev__label">{labelOf(item)}</span>
                      {item.type === 'view' && item.children?.length ? (
                        <span className="set-prev__glyph" aria-hidden>
                          ▾
                        </span>
                      ) : null}
                    </div>
                    {item.type === 'view'
                      ? (item.children ?? []).map((child) => (
                          <div className="set-prev__child" key={child.ref}>
                            <span>{labelOf(child)}</span>
                          </div>
                        ))
                      : null}
                  </div>
                ))}
              </div>
            ))}
          </div>
          <div className="set-prev__foot">
            {dirty ? 'unsaved changes — preview only' : menuOriginLine(menu)}
          </div>
        </aside>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// rows
// ---------------------------------------------------------------------------

function ItemRows({
  group,
  item,
  itemIndex,
  editable,
  dragging,
  setDragging,
  draft,
  setDraft,
  freeKinds,
  freeViews,
}: {
  group: MenuGroup;
  item: MenuItem;
  itemIndex: number;
  editable: boolean;
  dragging: null | { row: RowKind; groupId?: string; index: number };
  setDragging: (d: null | { row: RowKind; groupId?: string; index: number }) => void;
  draft: MenuDraft;
  setDraft: (fn: (d: MenuDraft) => MenuDraft) => void;
  freeKinds: string[];
  freeViews: MenuViewRef[];
}) {
  const children = item.type === 'view' ? (item.children ?? []) : [];
  const cap = childCapacity(draft, group.id, itemIndex);
  // `editable` was MISSING from this condition and the version-lock sweep in
  // settings.test.tsx caught it: every other control went read-only and this
  // one stayed live, which is precisely the "read-only" claim being false at
  // one control — the shape of defect a per-control eyeball never finds.
  const canAddChild =
    editable && item.type === 'view' && !cap.full && (freeKinds.length > 0 || freeViews.length > 0);

  return (
    <>
      <div
        className={rowClass('item', dragging, group.id, itemIndex)}
        draggable={editable}
        onDragStart={() => setDragging({ row: 'item', groupId: group.id, index: itemIndex })}
        onDragEnd={() => setDragging(null)}
        onDragOver={(e) => e.preventDefault()}
        onDrop={() => {
          if (dragging?.row === 'item' && dragging.groupId === group.id) {
            setDraft((d) => moveItem(d, group.id, dragging.index, itemIndex));
          }
          setDragging(null);
        }}
        data-testid="menu-item-row"
      >
        <Grip
          name={labelOf(item)}
          disabled={!editable}
          onMove={(delta) => setDraft((d) => moveItem(d, group.id, itemIndex, itemIndex + delta))}
        />
        <span className="set-row__glyph" aria-hidden>
          {glyphOf(item)}
        </span>
        <span className="set-row__label">
          {labelOf(item)}{' '}
          <span className="set-row__type">
            {item.type} ref{children.length ? ` · ${children.length} children` : ''}
          </span>
        </span>
        <button
          type="button"
          className="set-row__x"
          aria-label={`remove ${labelOf(item)}`}
          disabled={!editable}
          onClick={() => setDraft((d) => removeItem(d, group.id, itemIndex))}
        >
          ✕
        </button>
      </div>

      {children.map((child, ci) => (
        <div className="set-row set-row--child" key={child.ref} data-testid="menu-child-row">
          <Grip
            name={labelOf(child)}
            disabled={!editable}
            onMove={(delta) => setDraft((d) => moveChild(d, group.id, itemIndex, ci, ci + delta))}
          />
          <span className="set-row__label">{labelOf(child)}</span>
          <button
            type="button"
            className="set-row__x"
            aria-label={`remove ${labelOf(child)}`}
            disabled={!editable}
            onClick={() => setDraft((d) => removeChild(d, group.id, itemIndex, ci))}
          >
            ✕
          </button>
        </div>
      ))}

      {/* The control keeps one stable name. Capacity belongs in the refusal
          reason, where it explains availability without outranking the act. */}
      {item.type === 'view' && children.length > 0 ? (
        <div className="set-row set-row--child set-menu__childbar">
          {canAddChild ? (
            <button
              type="button"
              className="set-add"
              onClick={() => {
                const leaf: MenuLeaf =
                  freeKinds.length > 0
                    ? ({ type: 'kind', ref: freeKinds[0] } as MenuLeaf)
                    : { type: 'view', ref: freeViews[0] };
                setDraft((d) => addChild(d, group.id, itemIndex, leaf));
              }}
            >
              Add child
            </button>
          ) : (
            <DisabledAction
              reason={cap.full ? menuChildCapReason(cap.used, cap.max) : MENU_NO_FREE_KIND_REF}
              label="add child"
            >
              Add child
            </DisabledAction>
          )}
        </div>
      ) : null}
    </>
  );
}

/**
 * The grip. Draggable by pointer, and alt+↑/↓ by keyboard — a reorder that
 * only exists under a mouse is a control a keyboard user can see and never
 * use, which is the same defect the focusable refusal treatment fixes.
 *
 * AND ON TOUCH, NEITHER OF THOSE EXISTS. The rows reorder through HTML5
 * drag-and-drop (`draggable` / `onDragStart` / `onDrop`), and **HTML5 DnD does
 * not fire on touch at all** — there is no touch gesture that produces a
 * `dragstart`. The keyboard path did not cover for it either: alt+arrow needs an
 * alt key. So reordering this menu was not awkward on a touch device, it was
 * IMPOSSIBLE, on a control that looks exactly as available as it does on a
 * desktop. The grip even declared `touch-action: none`, suppressing the page pan
 * in exchange for a gesture that never arrived.
 *
 * The fix is explicit move buttons rather than a touch drag implementation:
 * a drag needs a target to aim at, and aiming a finger at a 24px row while the
 * list scrolls under it is a worse control than two buttons that say what they
 * do. They are rendered always and revealed by `(pointer: coarse)` — not by the
 * mobile shell, because Settings has NO phone port and serves the refusal screen
 * at 390px. The surface this is actually for is the coarse-pointer tablet, which
 * runs the DESKTOP shell. Under a fine pointer the CSS leaves the grip alone and
 * nothing about the desktop control changes.
 */
function Grip({
  name,
  disabled,
  onMove,
}: {
  /** The BARE row name ("Home"), not a phrase. Both controls below build their
   *  own accessible name from it, and they must not collide: a `getByRole` for
   *  the grip that also matched the move buttons would make every existing
   *  reorder query ambiguous. */
  name: string;
  disabled: boolean;
  onMove: (delta: number) => void;
}) {
  return (
    <span className="set-grip-wrap">
      <button
        type="button"
        className="set-grip"
        aria-label={`reorder ${name} — alt+arrow to move`}
        disabled={disabled}
        onKeyDown={(e) => {
          if (!e.altKey) return;
          if (e.key === 'ArrowUp') {
            e.preventDefault();
            onMove(-1);
          }
          if (e.key === 'ArrowDown') {
            e.preventDefault();
            onMove(1);
          }
        }}
      >
        ⠿
      </button>
      <span className="set-move" data-testid="menu-move-controls">
        <button
          type="button"
          className="set-move__btn"
          aria-label={`move ${name} up`}
          disabled={disabled}
          onClick={() => onMove(-1)}
        >
          ▲
        </button>
        <button
          type="button"
          className="set-move__btn"
          aria-label={`move ${name} down`}
          disabled={disabled}
          onClick={() => onMove(1)}
        >
          ▼
        </button>
      </span>
    </span>
  );
}

function AddControl({
  label,
  enabled,
  reason,
  onClick,
}: {
  label: string;
  enabled: boolean;
  reason: { cause: string; remedy?: string };
  onClick: () => void;
}) {
  if (!enabled) {
    return (
      <DisabledAction reason={reason} label={label}>
        {label}
      </DisabledAction>
    );
  }
  return (
    <button type="button" className="set-add" onClick={onClick}>
      {label}
    </button>
  );
}

/**
 * The picker. Deliberately a plain list of buttons rather than a `<select>`:
 * the set is small, every option carries its glyph, and a native select would
 * hide the one fact that matters — that the set is CLOSED and short.
 */
function Picker({
  picker,
  groups,
  freeViews,
  freeKinds,
  onCancel,
  onPickRef,
  onNewGroup,
}: {
  picker: { kind: 'view' | 'kind' | 'group'; groupId?: string };
  groups: MenuGroup[];
  freeViews: MenuViewRef[];
  freeKinds: string[];
  onCancel: () => void;
  onPickRef: (groupId: string, leaf: MenuLeaf) => void;
  onNewGroup: (label: string) => void;
}) {
  const [target, setTarget] = useState(groups[0]?.id ?? '');
  const [label, setLabel] = useState('');

  if (picker.kind === 'group') {
    return (
      <div className="set-picker">
        <input
          className="set-rename"
          aria-label="new group name"
          value={label}
          placeholder="LIBRARY"
          onChange={(e) => setLabel(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && label.trim()) onNewGroup(label.trim());
            if (e.key === 'Escape') onCancel();
          }}
        />
        <button type="button" className="set-add" disabled={!label.trim()} onClick={() => onNewGroup(label.trim())}>
          add group
        </button>
        <button type="button" className="set-ghost" onClick={onCancel}>
          cancel
        </button>
      </div>
    );
  }

  const refs: MenuLeaf[] =
    picker.kind === 'view'
      ? freeViews.map((ref) => ({ type: 'view', ref }))
      : freeKinds.map((ref) => ({ type: 'kind', ref }) as MenuLeaf);

  return (
    <div className="set-picker">
      <select
        className="set-field"
        aria-label="add to group"
        value={target}
        onChange={(e) => setTarget(e.target.value)}
      >
        {groups.map((g) => (
          <option key={g.id} value={g.id}>
            {g.label}
          </option>
        ))}
      </select>
      {refs.map((leaf) => (
        <button key={leaf.ref} type="button" className="set-add" onClick={() => onPickRef(target, leaf)}>
          {glyphOf(leaf)} {labelOf(leaf)}
        </button>
      ))}
      <button type="button" className="set-ghost" onClick={onCancel}>
        cancel
      </button>
    </div>
  );
}

// ---------------------------------------------------------------------------
// presentation — icons and labels come from the ref, never from the editor
// ---------------------------------------------------------------------------

/**
 * Oracle L388: "Icons come from the ref's kind or view automatically". View
 * refs resolve through the shell's presentation table; kind refs through the
 * domain registry — the same two sources the rail itself uses, so a row cannot
 * preview one way and render another.
 */
export function glyphOf(leaf: MenuItem | MenuLeaf): ReactNode {
  /* The editor previews the rail, so it must draw what the rail draws — the
     registry's artwork for kinds and the view table's for views. A text glyph
     here beside a drawn one there is the same row previewing one way and
     rendering another, which is the failure this function's docblock was
     already written to prevent. */
  if (leaf.type === 'view') {
    const view = VIEW_PRESENTATION[leaf.ref];
    return view ? <VectorIcon paths={view.art} /> : <KindIcon kind={CUSTOM_KIND_FALLBACK} />;
  }
  return <KindIcon kind={leaf.ref} />;
}

export function labelOf(leaf: MenuItem | MenuLeaf): string {
  if (leaf.type === 'view') return VIEW_PRESENTATION[leaf.ref]?.label ?? leaf.ref;
  return getKind(leaf.ref).labelPlural;
}

function rowClass(
  row: RowKind,
  dragging: null | { row: RowKind; groupId?: string; index: number },
  groupId: string,
  index: number,
): string {
  const base = row === 'group' ? 'set-row set-row--group' : 'set-row set-row--item';
  const isDragging =
    dragging?.row === row &&
    dragging.index === index &&
    (row === 'group' || dragging.groupId === groupId);
  return isDragging ? `${base} set-row--dragging` : base;
}

/** Why the preview shows what it shows, when there is nothing unsaved to say. */
function menuOriginLine(menu: ResolvedMenu): string {
  if (menu.origin.source === 'server') return `saved — space menu v${menu.origin.revision}`;
  if (menu.origin.because === 'absent') return 'this space has no saved menu — showing the shipped default';
  return `showing the shipped default — ${menu.origin.detail ?? menu.origin.because}`;
}

/** Re-exported so a test can assert the caps the disabled control states. */
export { MENU_CAPS };
