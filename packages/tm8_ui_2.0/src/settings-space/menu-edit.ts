/**
 * T2-3 — THE MENU EDITOR'S MODEL. Pure values, no React, no seam.
 *
 * THE ONE IDEA THIS FILE IS BUILT ON: the editor's validator is the RAIL's
 * validator. `shell/menu-resolve.ts` already decides what the rail renders —
 * ≤8 groups, ≤12 items, ≤8 children, depth exactly ≤1, unique ids, unique
 * refs, a surviving `settings` row, and kind refs the registry can resolve.
 * Restating those rules here would create four magic numbers that can drift
 * away from the rail without anything going red; the drift would present to a
 * user as "I saved a menu and the rail ignored half of it". So `draftIssue()`
 * runs the draft through `resolveMenu` and reports whether the rail would take
 * it. The cap CONSTANTS below exist only so a disabled control can state its
 * number ("this row has 8 of 8"), and `menu-edit.test.ts` asserts each one
 * sits exactly where `resolveMenu` flips.
 *
 * The oracle (T2-3, L275–391) draws exactly three row types — group / plain
 * item / caret view with one level of children — and its own note says why:
 * "nothing expressible in the editor can break T1-1's rendering rules". This
 * model can express nothing else, which is that note made structural.
 *
 * SAVE IS NOT HERE, and that is not an omission. `data/seam.ts` says verbatim
 * that `spaces.menu.update` "stays OUT of this seam until their phase; adding
 * it is a deferred amendment requiring dual re-consensus". Every function here
 * is client-side; the commit verb has no executor, and the editor renders it
 * disabled-with-reason (see `reasons.ts`).
 */
import type { MenuConfig, MenuConfigPayload, MenuGroup, MenuItem, MenuLeaf, MenuViewRef } from '@tm8/contract';
import { collectionKinds, isMenuEligibleKind } from '../domain';
import { VIEW_PRESENTATION, resolveMenu } from '../shell/menu-resolve';

/**
 * The rail's structural limits, mirrored so a DISABLED CONTROL CAN STATE ITS
 * NUMBER. They are not the authority — `draftIssue` is. Each value is
 * cross-checked against `resolveMenu`'s actual flip point by the tests, so a
 * change to the rail's `isRenderableMenu` turns this file red rather than
 * letting the editor quietly offer a menu the rail will throw away.
 */
export const MENU_CAPS = { groups: 8, items: 12, children: 8 } as const;

/**
 * A draft holds BOTH halves: the config as loaded, and the payload being
 * edited. Keeping `base` is what makes `isDirty` mean "differs from what was
 * loaded" rather than "someone touched it" — a reorder-and-undo must read
 * clean, or the Save control claims a change that does not exist.
 */
export interface MenuDraft {
  base: MenuConfig;
  payload: MenuConfigPayload;
}

export interface Capacity {
  used: number;
  max: number;
  full: boolean;
}

function clone(payload: MenuConfigPayload): MenuConfigPayload {
  return {
    schemaVersion: payload.schemaVersion,
    groups: payload.groups.map((g) => ({
      id: g.id,
      label: g.label,
      items: g.items.map((i) =>
        i.type === 'view'
          ? { type: 'view' as const, ref: i.ref, ...(i.children ? { children: i.children.map((c) => ({ ...c })) } : {}) }
          : { type: 'kind' as const, ref: i.ref },
      ),
    })),
  };
}

function next(draft: MenuDraft, mutate: (groups: MenuGroup[]) => void): MenuDraft {
  const payload = clone(draft.payload);
  mutate(payload.groups);
  return { base: draft.base, payload };
}

export function startDraft(config: MenuConfig): MenuDraft {
  return { base: config, payload: clone({ schemaVersion: config.schemaVersion, groups: config.groups }) };
}

/**
 * The draft AS A CONFIG. The revision rides along from the base because that is
 * the `expectedRevision` any future `spaces.menu.update` would carry — the
 * conflict state (T2-3, L365) is precisely "this editor holds v12, the space is
 * on v13", so the number has to survive editing.
 */
export function draftConfig(draft: MenuDraft): MenuConfig {
  return { ...draft.payload, revision: draft.base.revision };
}

export function isDirty(draft: MenuDraft): boolean {
  return JSON.stringify(draft.payload.groups) !== JSON.stringify(draft.base.groups);
}

/**
 * `null` when the rail would render this draft as-is; otherwise a sentence
 * naming what is wrong. Deliberately NOT a boolean: an editor that greys Save
 * without saying why is the silent refusal R7 forbids.
 *
 * The specific messages are derived from `resolveMenu`'s own fallback reason,
 * plus one local check the resolver cannot express — it reports `malformed`
 * for a missing `settings` row and for a blank label alike, and those are very
 * different things to tell a user.
 */
export function draftIssue(draft: MenuDraft): string | null {
  const config = draftConfig(draft);

  if (!hasSettingsRow(config)) {
    return 'the Settings row is gone — the rail refuses a menu with no way back to settings';
  }
  for (const g of config.groups) {
    if (g.label.trim().length === 0) return `a group has no name — every band needs a label`;
    if (g.label.length > 32) return `“${g.label.slice(0, 12)}…” is longer than 32 characters`;
  }

  const resolved = resolveMenu(config);
  if (resolved.origin.source === 'server') return null;
  if (resolved.origin.because === 'unrenderable-refs') {
    return resolved.origin.detail ?? 'this menu names rows the rail cannot render';
  }
  return resolved.origin.detail ?? 'the rail would refuse this menu and fall back to the shipped default';
}

function hasSettingsRow(config: MenuConfig): boolean {
  return allRefs(config).includes(SETTINGS_REF);
}

/**
 * The `settings` view ref, reached through the shell's presentation table
 * rather than typed. It is a VIEW ref, not a kind, so §15.2 does not bite —
 * but sourcing it from the table means a rename of the ref breaks the build
 * here instead of silently disabling this check.
 */
const SETTINGS_REF: MenuViewRef = (Object.keys(VIEW_PRESENTATION) as MenuViewRef[]).find(
  (ref) => VIEW_PRESENTATION[ref].label === 'Settings',
)!;

function allRefs(config: MenuConfigPayload): string[] {
  const out: string[] = [];
  for (const g of config.groups) {
    for (const i of g.items) {
      out.push(i.ref);
      if (i.type === 'view') for (const c of i.children ?? []) out.push(c.ref);
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Reorder
// ---------------------------------------------------------------------------

function move<T>(list: T[], from: number, to: number): boolean {
  if (from < 0 || to < 0 || from >= list.length || to >= list.length || from === to) return false;
  const [row] = list.splice(from, 1);
  list.splice(to, 0, row);
  return true;
}

export function moveGroup(draft: MenuDraft, from: number, to: number): MenuDraft {
  return next(draft, (groups) => {
    move(groups, from, to);
  });
}

export function moveItem(draft: MenuDraft, groupId: string, from: number, to: number): MenuDraft {
  return next(draft, (groups) => {
    const g = groups.find((x) => x.id === groupId);
    if (g) move(g.items, from, to);
  });
}

export function moveChild(
  draft: MenuDraft,
  groupId: string,
  itemIndex: number,
  from: number,
  to: number,
): MenuDraft {
  return next(draft, (groups) => {
    const children = childrenOf(groups, groupId, itemIndex);
    if (children) move(children, from, to);
  });
}

function childrenOf(groups: MenuGroup[], groupId: string, itemIndex: number): MenuLeaf[] | null {
  const g = groups.find((x) => x.id === groupId);
  const item = g?.items[itemIndex];
  if (!item || item.type !== 'view') return null;
  if (!item.children) item.children = [];
  return item.children;
}

// ---------------------------------------------------------------------------
// Rename / remove
// ---------------------------------------------------------------------------

export function renameGroup(draft: MenuDraft, groupId: string, label: string): MenuDraft {
  return next(draft, (groups) => {
    const g = groups.find((x) => x.id === groupId);
    if (g) g.label = label;
  });
}

export function removeGroup(draft: MenuDraft, groupId: string): MenuDraft {
  return next(draft, (groups) => {
    const at = groups.findIndex((x) => x.id === groupId);
    if (at >= 0) groups.splice(at, 1);
  });
}

export function removeItem(draft: MenuDraft, groupId: string, index: number): MenuDraft {
  return next(draft, (groups) => {
    const g = groups.find((x) => x.id === groupId);
    if (g && index >= 0 && index < g.items.length) g.items.splice(index, 1);
  });
}

export function removeChild(
  draft: MenuDraft,
  groupId: string,
  itemIndex: number,
  childIndex: number,
): MenuDraft {
  return next(draft, (groups) => {
    const children = childrenOf(groups, groupId, itemIndex);
    if (children && childIndex >= 0 && childIndex < children.length) children.splice(childIndex, 1);
  });
}

// ---------------------------------------------------------------------------
// Add — every add is capacity-checked, so a control can be disabled WITH the number
// ---------------------------------------------------------------------------

export function groupCapacity(draft: MenuDraft): Capacity {
  const used = draft.payload.groups.length;
  return { used, max: MENU_CAPS.groups, full: used >= MENU_CAPS.groups };
}

export function itemCapacity(draft: MenuDraft, groupId: string): Capacity {
  const used = draft.payload.groups.find((g) => g.id === groupId)?.items.length ?? 0;
  return { used, max: MENU_CAPS.items, full: used >= MENU_CAPS.items };
}

export function childCapacity(draft: MenuDraft, groupId: string, itemIndex: number): Capacity {
  const item = draft.payload.groups.find((g) => g.id === groupId)?.items[itemIndex];
  const used = item && item.type === 'view' ? (item.children?.length ?? 0) : 0;
  return { used, max: MENU_CAPS.children, full: used >= MENU_CAPS.children };
}

export function addItem(draft: MenuDraft, groupId: string, leaf: MenuLeaf): MenuDraft {
  if (itemCapacity(draft, groupId).full) return draft;
  return next(draft, (groups) => {
    const g = groups.find((x) => x.id === groupId);
    if (g) g.items.push(leaf as MenuItem);
  });
}

export function addChild(
  draft: MenuDraft,
  groupId: string,
  itemIndex: number,
  leaf: MenuLeaf,
): MenuDraft {
  if (childCapacity(draft, groupId, itemIndex).full) return draft;
  return next(draft, (groups) => {
    const children = childrenOf(groups, groupId, itemIndex);
    if (children) children.push(leaf);
  });
}

/**
 * Group ids are SCHEMA-CONSTRAINED (`/^[a-z0-9][a-z0-9-]{0,31}$/`), and the
 * oracle lets the user type a free-text label. So the id is DERIVED from the
 * label and then made unique — never typed by the user, and never left to
 * collide, because a duplicate id is one of the things that makes the rail
 * throw the whole config away.
 */
export function addGroup(draft: MenuDraft, label: string): MenuDraft {
  if (groupCapacity(draft).full) return draft;
  const taken = new Set(draft.payload.groups.map((g) => g.id));
  const base = label.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 32);
  const seed = /^[a-z0-9]/.test(base) ? base : `g${base}`;
  let id = seed;
  for (let n = 2; taken.has(id); n += 1) id = `${seed.slice(0, 29)}-${n}`;
  return next(draft, (groups) => {
    groups.push({ id, label, items: [] });
  });
}

// ---------------------------------------------------------------------------
// What the pickers may offer
// ---------------------------------------------------------------------------

/**
 * Every view ref the rail knows, minus the ones already placed. Refs must be
 * unique across the whole config (the resolver rejects a duplicate outright),
 * so this is a global exclusion, not a per-group one.
 *
 * On the SHIPPED DEFAULT this returns an EMPTY array — `MenuViewRef` is a
 * closed union of seven and the default spends all seven. That is a measured
 * fact with a UI consequence: "＋ view ref" renders disabled-with-reason
 * rather than opening an empty picker.
 */
export function availableViewRefs(draft: MenuDraft): MenuViewRef[] {
  const used = new Set(allRefs(draft.payload));
  return (Object.keys(VIEW_PRESENTATION) as MenuViewRef[]).filter((ref) => !used.has(ref));
}

/**
 * Kind refs come from the REGISTRY, filtered by the rail's own eligibility
 * predicate (`isMenuEligibleKind` — collection strategy, has a slug, not the
 * `c:*` sentinel). No kind is named here: §15.2 holds, and the offered set
 * grows automatically when a kind is added to the registry.
 */
export function availableKindRefs(draft: MenuDraft): string[] {
  const used = new Set(allRefs(draft.payload));
  return collectionKinds()
    .map((row) => row.kind)
    .filter((kind) => !used.has(kind) && isMenuEligibleKind(kind));
}
