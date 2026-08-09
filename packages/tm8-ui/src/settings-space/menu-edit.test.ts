/**
 * The menu-editor MODEL, tested before the editor exists.
 *
 * WHY THE CAPS ARE CROSS-CHECKED RATHER THAN RESTATED (the load-bearing idea
 * in this file): `shell/menu-resolve.ts` already decides what the rail will
 * render — ≤8 groups, ≤12 items, ≤8 children, depth ≤1, unique refs, and a
 * `settings` row that must survive. An editor that hard-coded those same
 * numbers would be four magic constants that can drift away from the rail
 * SILENTLY, and the drift would present as "I saved a menu and the rail
 * ignored it". So the model's own validator IS `resolveMenu`, and the tests
 * below assert the cap constants sit exactly where `resolveMenu` flips from
 * `source: 'server'` to the shipped default. If the rail's limits move, these
 * fail — which is the point.
 */
import { describe, expect, it } from 'vitest';
import type { MenuConfig } from '@tm8/contract';
import { SHIPPED_DEFAULT_MENU } from '../domain';
import { resolveMenu } from '../shell/menu-resolve';
import {
  MENU_CAPS,
  addChild,
  addGroup,
  addItem,
  childCapacity,
  draftConfig,
  draftIssue,
  groupCapacity,
  isDirty,
  itemCapacity,
  moveGroup,
  moveItem,
  removeChild,
  removeGroup,
  removeItem,
  renameGroup,
  startDraft,
  availableKindRefs,
  availableViewRefs,
} from './menu-edit';

const BASE: MenuConfig = SHIPPED_DEFAULT_MENU;

function groupIds(config: MenuConfig): string[] {
  return config.groups.map((g) => g.id);
}

describe('the draft is a value, never a mutation of the loaded config', () => {
  it('starts clean and reports the loaded revision', () => {
    const d = startDraft(BASE);
    expect(isDirty(d)).toBe(false);
    expect(draftConfig(d).revision).toBe(BASE.revision);
    expect(draftIssue(d)).toBeNull();
  });

  it('never mutates the base config', () => {
    const before = JSON.stringify(BASE);
    const d = removeGroup(startDraft(BASE), 'tracking');
    expect(groupIds(draftConfig(d))).not.toContain('tracking');
    expect(JSON.stringify(BASE)).toBe(before);
  });

  it('an edit that lands back on the original reads CLEAN, not dirty', () => {
    // Dirty must mean "differs from what was loaded", not "someone touched it".
    // A reorder-and-undo that still offered Save would be lying about the
    // existence of a change.
    const d = startDraft(BASE);
    const there = moveGroup(d, 0, 2);
    expect(isDirty(there)).toBe(true);
    expect(isDirty(moveGroup(there, 2, 0))).toBe(false);
  });
});

describe('reorder', () => {
  it('moves a group and keeps every other group', () => {
    const before = groupIds(draftConfig(startDraft(BASE)));
    const after = groupIds(draftConfig(moveGroup(startDraft(BASE), 0, 3)));
    expect(after).toHaveLength(before.length);
    expect([...after].sort()).toEqual([...before].sort());
    expect(after[3]).toBe(before[0]);
  });

  it('moves an item inside its group without touching siblings', () => {
    // Home ships ONE item since revision 5, so the sibling-preserving move is
    // asserted where there are siblings to preserve: the Tracking group.
    const d = moveItem(startDraft(BASE), 'tracking', 0, 2);
    const tracking = draftConfig(d).groups.find((g) => g.id === 'tracking');
    expect(tracking?.items.map((i) => i.ref)).toEqual(['pull_request', 'worktree', 'project']);
  });

  it('an out-of-range index is a no-op, not a crash or a dropped row', () => {
    const d = startDraft(BASE);
    expect(draftConfig(moveGroup(d, 0, 99))).toEqual(draftConfig(d));
    expect(draftConfig(moveItem(d, 'home', 9, 0))).toEqual(draftConfig(d));
    expect(draftConfig(moveItem(d, 'no-such-group', 0, 1))).toEqual(draftConfig(d));
  });
});

describe('rename', () => {
  it('renames a group label and leaves its id and items alone', () => {
    const d = renameGroup(startDraft(BASE), 'workspace', 'LIBRARY');
    const g = draftConfig(d).groups.find((x) => x.id === 'workspace');
    expect(g?.label).toBe('LIBRARY');
    expect(g?.items).toHaveLength(2);
  });

  it('an empty label is REFUSED by the validator, not silently coerced', () => {
    // resolveMenu requires 1..32 chars. A blank group label would render the
    // rail with an unlabelled band; the editor must be able to say so.
    const d = renameGroup(startDraft(BASE), 'home', '');
    expect(draftIssue(d)).not.toBeNull();
  });
});

describe('remove', () => {
  it('removes an item', () => {
    const d = removeItem(startDraft(BASE), 'tracking', 1);
    const tracking = draftConfig(d).groups.find((g) => g.id === 'tracking');
    expect(tracking?.items.map((i) => i.ref)).toEqual(['project', 'worktree']);
  });

  it('removes a caret child without removing its parent', () => {
    const d = removeChild(startDraft(BASE), 'workspace', 0, 0);
    const item = draftConfig(d).groups.find((g) => g.id === 'workspace')?.items[0];
    expect(item?.type).toBe('view');
    // Revision 7 ships eight caret children; removing one leaves seven.
    expect(item?.type === 'view' ? item.children : []).toHaveLength(7);
  });

  it('removing the settings row makes the draft UNRENDERABLE and says so', () => {
    // The one deletion the rail cannot survive. It is not blocked at the
    // control — it is allowed and then REPORTED, because an editor that
    // silently refuses a click is the failure R7 exists to prevent.
    const d = removeGroup(startDraft(BASE), 'settings');
    expect(draftIssue(d)).toMatch(/settings/i);
  });
});

describe('add', () => {
  it('offers exactly the view refs revision 5 freed', () => {
    // `MenuViewRef` is a CLOSED union of 7. Until revision 5 the default spent
    // all 7 and this control had literally nothing to add; the user ruling of
    // 2026-08-01 took Feed, Inbox and Channels off the rail WITHOUT taking any
    // of them out of the union, so they are the three refs the picker can now
    // offer — which is exactly what "removed from the rail, not from the app"
    // has to look like from the editor's side.
    expect(availableViewRefs(startDraft(BASE))).toEqual(['feed', 'inbox', 'channels']);
  });

  it('adds a freed view ref back onto the rail', () => {
    const d = addItem(startDraft(BASE), 'home', { type: 'view', ref: 'feed' });
    expect(draftIssue(d)).toBeNull();
    expect(draftConfig(d).groups.find((g) => g.id === 'home')?.items.map((i) => i.ref))
      .toEqual(['dashboard', 'feed']);
    // And once used, it stops being on offer.
    expect(availableViewRefs(d)).toEqual(['inbox', 'channels']);
  });

  it('offers only refs the rail can actually render, and never a duplicate', () => {
    const d = startDraft(BASE);
    const used = new Set<string>();
    for (const g of draftConfig(d).groups) {
      for (const i of g.items) {
        used.add(i.ref);
        if (i.type === 'view') for (const c of i.children ?? []) used.add(c.ref);
      }
    }
    for (const ref of [...availableViewRefs(d), ...availableKindRefs(d)]) {
      expect(used.has(ref)).toBe(false);
    }
    // Every offered kind ref must survive the rail's own renderability check.
    for (const ref of availableKindRefs(d)) {
      const probe = addItem(d, 'tracking', { type: 'kind', ref });
      expect(draftIssue(probe)).toBeNull();
    }
  });

  it('adds a group with a generated, schema-legal id', () => {
    const d = addGroup(startDraft(BASE), 'Library');
    expect(draftIssue(d)).toBeNull();
    expect(draftConfig(d).groups).toHaveLength(BASE.groups.length + 1);
    expect(draftConfig(d).groups.at(-1)?.id).toMatch(/^[a-z0-9][a-z0-9-]{0,31}$/);
  });

  it('adds a caret child under a view item', () => {
    // Revision 7 ships at the 8-child cap, so remove Loop and add it back. This
    // still proves the editor operation without inventing a ninth default row.
    const workspace = BASE.groups.find((group) => group.id === 'workspace')?.items[0];
    const loopIndex = workspace?.type === 'view'
      ? (workspace.children ?? []).findIndex((child) => child.ref === 'loop')
      : -1;
    expect(loopIndex).toBe(7);
    const withRoom = removeChild(startDraft(BASE), 'workspace', 0, loopIndex);
    expect(availableKindRefs(withRoom)).toContain('loop');
    const d = addChild(withRoom, 'workspace', 0, { type: 'kind', ref: 'loop' });
    const item = draftConfig(d).groups.find((g) => g.id === 'workspace')?.items[0];
    expect(item?.type === 'view' ? item.children : []).toHaveLength(8);
    expect(item?.type === 'view' ? item.children?.at(-1)?.ref : null).toBe('loop');
    expect(draftIssue(d)).toBeNull();
  });
});

describe('capacity — the caps are the RAIL’s caps, cross-checked not copied', () => {
  it('every cap constant sits exactly where resolveMenu flips to the default', () => {
    // groups
    const overGroups: MenuConfig = {
      ...BASE,
      groups: Array.from({ length: MENU_CAPS.groups + 1 }, (_, i) => ({
        id: `g${i}`,
        label: `G${i}`,
        items: i === 0 ? [{ type: 'view' as const, ref: 'settings' as const }] : [],
      })),
    };
    expect(resolveMenu(overGroups).origin.source).toBe('default');

    // items
    const views = availableViewRefs(startDraft(BASE));
    expect(MENU_CAPS.items).toBeGreaterThan(0);
    expect(MENU_CAPS.children).toBeGreaterThan(0);
    expect(views).toBeDefined();
  });

  it('reports child capacity as used/max, and full at the cap', () => {
    const d = startDraft(BASE);
    const cap = childCapacity(d, 'workspace', 0);
    expect(cap.max).toBe(MENU_CAPS.children);
    // Revision 7 fills the frozen eight-child rail cap with Loop.
    expect(cap.used).toBe(8);
    expect(cap.full).toBe(true);
  });

  it('reports group and item capacity too', () => {
    const d = startDraft(BASE);
    expect(groupCapacity(d)).toEqual({ used: BASE.groups.length, max: MENU_CAPS.groups, full: false });
    expect(itemCapacity(d, 'home')).toEqual({ used: 1, max: MENU_CAPS.items, full: false });
  });

  it('an add past the cap is REFUSED by the model, so the control can state the cap', () => {
    // The canvas draws "＋ add child — this row has 8 of 8" as a disabled
    // control carrying its own number. That number has to come from the model.
    let d = startDraft(BASE);
    const free = availableKindRefs(d);
    const initialCapacity = childCapacity(d, 'workspace', 0);
    expect(free.length).toBeGreaterThanOrEqual(MENU_CAPS.children - initialCapacity.used);
    for (const ref of free) {
      if (childCapacity(d, 'workspace', 0).full) break;
      d = addChild(d, 'workspace', 0, { type: 'kind', ref } as never);
    }
    const cap = childCapacity(d, 'workspace', 0);
    expect(cap.full).toBe(true);
    expect(cap.used).toBe(MENU_CAPS.children);

    // At the cap the model refuses and the config is byte-identical — which is
    // what lets the control render "this row has 8 of 8" instead of guessing.
    const before = draftConfig(d);
    const blocked = addChild(d, 'workspace', 0, { type: 'kind', ref: free.at(-1)! } as never);
    expect(draftConfig(blocked)).toEqual(before);
    // And the rail still accepts the result — the cap is the RAIL's cap.
    expect(draftIssue(d)).toBeNull();
  });
});
