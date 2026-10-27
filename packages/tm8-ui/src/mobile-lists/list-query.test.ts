import { describe, expect, it } from 'vitest';
import { getKind } from '../domain';
import { landingOfRoute, routeViewOf } from '../domain/nav-targets';
import { decodeQ, encodeQ } from '../routes/q';
import {
  CAT_ALL,
  CAT_OPEN,
  activeLabels,
  defaultCategory,
  defaultSort,
  filterFor,
  pickForRoute,
  resolvePick,
  showModel,
  toggleOn,
} from './list-query';

const task = getKind('task');
const session = getKind('work_session');
const doc = getKind('doc');

describe('showModel — the ⚙ sheet is built from registry data', () => {
  it('tasks get a status radio with "Not done", and no duplicate status checkboxes', () => {
    const m = showModel(task);
    expect(m.categories.map((c) => c.id)).toEqual([CAT_ALL, CAT_OPEN, 'to_do', 'in_progress', 'done', 'cancelled']);
    expect(m.toggles.some((t) => t.specId === 'status')).toBe(false);
    expect(m.toggles.map((t) => t.key)).toContain('assignee:mine');
  });

  it('docs have no workflow, so no status radio that could only empty the list', () => {
    expect(showModel(doc).categories).toEqual([]);
  });

  it('sessions use their own tabs', () => {
    expect(showModel(session).categories.map((c) => c.id)).toContain('interrupted');
  });
});

describe('defaults', () => {
  it('tasks open on "not done", sessions on their declared default, docs on everything', () => {
    expect(defaultCategory(task)).toBe(CAT_OPEN);
    expect(defaultCategory(session)).toBe(session.list.defaultCategory);
    expect(defaultCategory(doc)).toBeUndefined();
    expect(defaultSort(doc)).toBe('updatedAt_desc');
  });

  it('an untouched list writes nothing to the address', () => {
    const resolved = resolvePick(task, undefined, undefined);
    expect(pickForRoute(task, resolved)).toEqual({});
  });
});

describe('resolvePick / pickForRoute round-trip', () => {
  it('keeps what the kind offers and drops what it does not', () => {
    const r = resolvePick(task, { cat: 'done', on: ['assignee:mine', 'nope:x'] }, 'priority');
    expect(r).toEqual({ cat: 'done', on: ['assignee:mine'], sort: 'priority' });
    expect(pickForRoute(task, r)).toEqual({ pick: { cat: 'done', on: ['assignee:mine'] }, sortBy: 'priority' });
  });

  it('an unknown sort falls back to the default', () => {
    expect(resolvePick(doc, undefined, 'dueDate').sort).toBe('updatedAt_desc');
  });
});

describe('filterFor — choices to one read', () => {
  it('resolves the viewer and narrows with the category', () => {
    const r = resolvePick(task, { on: ['assignee:mine'] }, undefined);
    expect(filterFor(task, r, 'actor-1')).toEqual({
      category: ['to_do', 'in_progress'],
      deleted: 'exclude',
      assigneeIds: ['actor-1'],
    });
  });

  it('drops a viewer-scoped option when nobody is signed in rather than sending "@me"', () => {
    const r = resolvePick(task, { on: ['assignee:mine'] }, undefined);
    expect(JSON.stringify(filterFor(task, r, undefined))).not.toContain('@me');
  });

  it('options of a single-select spec replace each other', () => {
    const m = showModel(task);
    const on = toggleOn(m, ['archived:only'], 'archived:include', false);
    expect(on).toEqual(['archived:include']);
    expect(toggleOn(m, on, 'archived:include', false)).toEqual([]);
  });

  it('labels only what differs from the default', () => {
    const m = showModel(task);
    expect(activeLabels(m, resolvePick(task, undefined, undefined), task)).toEqual([]);
    expect(activeLabels(m, resolvePick(task, { cat: CAT_ALL, on: ['assignee:mine'] }, undefined), task)).toEqual([
      'All',
      'Assigned to me',
    ]);
  });
});

describe('the address carries it (q.sortBy + q.pick)', () => {
  it('q round-trips pick and the updatedAt sort it used to reject', () => {
    const value = { v: 1 as const, sortBy: 'updatedAt_desc' as const, pick: { cat: 'done', on: ['assignee:mine'] } };
    expect(decodeQ(encodeQ(value))).toEqual(value);
  });

  it('a malformed pick discards the q atomically', () => {
    const raw = btoa(JSON.stringify({ v: 1, pick: { on: [1] } })).replace(/=+$/, '');
    expect(decodeQ(raw)).toBeNull();
  });

  it('a kind target with sort and pick survives route → target', () => {
    const target = { type: 'kind' as const, ref: 'task', sortBy: 'priority' as const, pick: { cat: 'done' } };
    const view = routeViewOf(target, null);
    expect(view).toMatchObject({ view: 'kind', q: { v: 1, sortBy: 'priority', pick: { cat: 'done' } } });
    const landing = landingOfRoute(view as never);
    expect(landing?.target).toMatchObject({ type: 'kind', ref: 'task', sortBy: 'priority', pick: { cat: 'done' } });
  });

  it('a plain kind target still writes no q', () => {
    expect(routeViewOf({ type: 'kind', ref: 'task' }, null)).toMatchObject({ q: null });
  });
});
