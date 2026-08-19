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
import {
  DEFAULT_MENU_CHANNELS_SPINE,
  DEFAULT_MENU_WORK_ITEM_SPINE,
  type MenuConfig,
} from '@tm8/contract';
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

/**
 * The ROW-BEARING base. Revision 17's shipped default is five railless
 * single-view groups (the unified Home owns every kind list), so the editor's
 * row operations are exercised against the revision-16 arrangement a
 * server-authored config can still carry — reorder, rename, carets and caps
 * must keep working for those. The shipped default itself is covered by the
 * free-refs case at the bottom.
 */
const BASE: MenuConfig = {
  schemaVersion: 1,
  revision: 16,
  groups: [
    { id: 'chats', label: 'Collab', items: [{ type: 'view', ref: 'dashboard' }] },
    { id: 'workspace', label: 'Work', items: [...DEFAULT_MENU_WORK_ITEM_SPINE] },
    { id: 'board', label: 'Board', items: [{ type: 'view', ref: 'board' }] },
    { id: 'graph', label: 'Graph', items: [{ type: 'view', ref: 'graph' }] },
    { id: 'channels', label: 'Channels', items: [...DEFAULT_MENU_CHANNELS_SPINE] },
    { id: 'files', label: 'Files', items: [{ type: 'view', ref: 'files' }] },
    { id: 'settings', label: 'Settings', items: [{ type: 'view', ref: 'settings' }] },
  ],
};

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
    // Revision 12: the multi-item groups are Channels (Channels · Messages)
    // and Work (caret · dev rows · git); the move is asserted where there are
    // siblings to swap.
    const d = moveItem(startDraft(BASE), 'channels', 0, 1);
    const channels = draftConfig(d).groups.find((g) => g.id === 'channels');
    expect(channels?.items.map((i) => i.ref)).toEqual(['messages', 'channel']);
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
    // Revision 12: caret · project · pull_request · worktree · git.
    expect(g?.items).toHaveLength(5);
  });

  it('an empty label is REFUSED by the validator, not silently coerced', () => {
    // resolveMenu requires 1..32 chars. A blank group label would render the
    // rail with an unlabelled band; the editor must be able to say so.
    const d = renameGroup(startDraft(BASE), 'graph', '');
    expect(draftIssue(d)).not.toBeNull();
  });
});

describe('remove', () => {
  it('removes an item', () => {
    const d = removeItem(startDraft(BASE), 'workspace', 1);
    const workspace = draftConfig(d).groups.find((g) => g.id === 'workspace');
    // Revision 12: index 1 is the `project` row; its siblings survive.
    expect(workspace?.items.map((i) => i.ref)).toEqual([
      'workspace',
      'pull_request',
      'worktree',
      'git',
    ]);
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
  it('offers exactly the view refs the rowed base leaves free', () => {
    // `MenuViewRef` is a CLOSED union. Until revision 5 the default spent every
    // member and this control had literally nothing to add; the user ruling of
    // 2026-08-01 took Feed, Inbox and Channels off the rail WITHOUT taking any
    // of them out of the union, which is what "removed from the rail, not from
    // the app" has to look like from the editor's side.
    //
    // INBOX REJOINED THE FREE SET on 2026-08-14 (revision 11): its rail row
    // retired for the top-bar bell, and a free ref is exactly what "off the
    // rail, not out of the app" looks like from the editor's side. Nothing
    // here is hardcoded: `availableViewRefs` is VIEW_PRESENTATION minus what
    // the draft already places, so this assertion moves whenever the shipped
    // default does — which is the point of it.
    //
    // DASHBOARD JOINED THE FREE SET on 2026-08-15 (revision 13) and LEFT IT
    // AGAIN the same day (revision 14): the Chats group places it, so the
    // editor no longer offers it. The round trip is the assertion's whole
    // value — it moved twice without anyone touching this list, because
    // `availableViewRefs` is VIEW_PRESENTATION minus what the draft places.
    // …and 'craft' joined it with revision 18 (Craft P1): the rowed BASE
    // predates the tab, so the editor offers the ref as an add.
    // …and 'help' joined it 2026-08-19 WITHOUT a revision bump, which is the
    // one new shape here: Help is a `VIEW_PRESENTATION` ref with a mounted
    // screen that NO shipped group places, so it is free in every draft by
    // construction. That is the point of it — its door is a bar control, and
    // an operator who wants it on the rail must be able to add it.
    expect(availableViewRefs(startDraft(BASE))).toEqual(['feed', 'inbox', 'channels', 'craft', 'help']);
  });

  it('the revision-19 shipped default frees the whole retired set — unrouted, not deleted', () => {
    // Task 01a00932: Work and Channels retired from the tab row, so their
    // view refs joined the free set. A viewer who wants a Work group back
    // can author one — this is the editor-side proof the flip deleted
    // nothing.
    //
    // Revision 19 (task 01a00b46, migration 140) took `workspace` back OUT of
    // the free set, and by the only mechanism that should ever remove a ref
    // from it: the shipped default now USES it, as the Work tab's single
    // item. The editor offers exactly the refs nothing has claimed, so a ref
    // leaving this list is the signal that it went back on the rail — not
    // that it was deleted. `git` and `messages`, the other two refs the old
    // Work group carried, are still free and still authorable.
    expect([...availableViewRefs(startDraft(SHIPPED_DEFAULT_MENU))].sort()).toEqual(
      // 'help' rides along: no group places it, so it is free here too.
      ['channels', 'feed', 'git', 'inbox', 'messages', 'help'].sort(),
    );
  });

  it('adds a freed view ref back onto the rail', () => {
    const d = addItem(startDraft(BASE), 'graph', { type: 'view', ref: 'feed' });
    expect(draftIssue(d)).toBeNull();
    expect(draftConfig(d).groups.find((g) => g.id === 'graph')?.items.map((i) => i.ref))
      .toEqual(['graph', 'feed']);
    // And once used, it stops being on offer.
    expect(availableViewRefs(d)).toEqual(['inbox', 'channels', 'craft', 'help']);
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
    // Revision 11: `file` took the eighth slot, so Loop sits seventh.
    expect(loopIndex).toBe(6);
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
    // Graph is a one-row group (revision 13 retired Home, which used to be the
    // single-row witness here). Derived from BASE rather than typed, so a
    // future edit moves this assertion with it instead of turning it red for
    // the wrong reason.
    const graphItems = BASE.groups.find((g) => g.id === 'graph')?.items.length ?? 0;
    expect(graphItems).toBe(1);
    expect(itemCapacity(d, 'graph')).toEqual({ used: graphItems, max: MENU_CAPS.items, full: false });
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
