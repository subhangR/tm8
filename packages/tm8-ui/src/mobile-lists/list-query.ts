/**
 * THE PHONE LIST'S SORT AND NARROWING — choices in, one collection read out.
 *
 * The ⚙ sheet in the mockup has two groups: **Sort** (radio) and **Show**
 * (a status radio plus checkboxes). Both are built from the kind's own
 * registry data — `list.sort`, `list.categories`, `list.filters` — so the phone
 * offers exactly what the desktop list can query and names no kind of its own
 * beyond the one default the mockup asks for (Tasks open "not done").
 *
 * The choices are ROUTE STATE (`MenuTarget.pick` / `q.pick`, CONTRACT §5). This
 * file turns them into the `(filter, sort)` pair `rowsFor` keys on, using the
 * desktop panel's own `narrow` so an impossible combination is refused the
 * same way on both shells.
 */
import type { KindConfig, QueryFilter, SortKey } from '../domain';
import { needsViewer } from '../domain';
import { narrow } from '../panels/EntityListPanel';
import type { ListPick } from '../routes/types';

export const VIEWER = '@me';
export const CAT_ALL = 'all';
export const CAT_OPEN = 'open';

export interface CategoryChoice {
  id: string;
  label: string;
  filter: QueryFilter | null;
}

export interface ToggleChoice {
  /** `specId:optionId`, the form carried in `pick.on`. */
  key: string;
  specId: string;
  label: string;
  filter: QueryFilter;
  /** A viewer-scoped option with no viewer to put in it — offered disabled, never sent. */
  needsViewer: boolean;
}

export interface ShowModel {
  categories: readonly CategoryChoice[];
  toggles: readonly ToggleChoice[];
}

/**
 * Does this kind's list have a status to narrow by? Only kinds whose rows
 * carry one: every registry entry declares the generic four category tabs,
 * but a doc or a chat has no workflow, so "To Do" would just empty the list.
 */
function hasStatus(config: KindConfig): boolean {
  return (
    (config.list.categories?.length ?? 0) > 0 &&
    (config.list.defaultCategory !== undefined || config.list.filters.some((f) => f.id === 'status'))
  );
}

export function showModel(config: KindConfig): ShowModel {
  const categories: CategoryChoice[] = [];
  if (hasStatus(config)) {
    categories.push({ id: CAT_ALL, label: 'All', filter: null });
    const tabs = config.list.categories ?? [];
    const open = tabs.filter((t) => t.id === 'to_do' || t.id === 'in_progress');
    if (open.length === 2) {
      categories.push({
        id: CAT_OPEN,
        label: 'Not done',
        filter: { category: ['to_do', 'in_progress'], deleted: 'exclude' } as QueryFilter,
      });
    }
    for (const tab of tabs) categories.push({ id: tab.id, label: tab.label, filter: tab.filter });
  }
  const toggles: ToggleChoice[] = [];
  for (const spec of config.list.filters) {
    /* The multi-select status chip is the category radio said again, one
       status at a time — two controls for one axis can only disagree. */
    if (spec.id === 'status' && categories.length > 0) continue;
    for (const option of spec.options) {
      toggles.push({
        key: `${spec.id}:${option.id}`,
        specId: spec.id,
        label: option.label,
        filter: option.filter,
        needsViewer: needsViewer(option.filter),
      });
    }
  }
  return { categories, toggles };
}

/** The status the list opens on. Tasks hide done work (mockup open question 6). */
export function defaultCategory(config: KindConfig, model: ShowModel = showModel(config)): string | undefined {
  if (model.categories.length === 0) return undefined;
  if (config.kind === 'task' && model.categories.some((c) => c.id === CAT_OPEN)) return CAT_OPEN;
  const declared = config.list.defaultCategory;
  return declared && model.categories.some((c) => c.id === declared) ? declared : CAT_ALL;
}

export function defaultSort(config: KindConfig): SortKey | undefined {
  return (config.list.sort.find((s) => s.default) ?? config.list.sort[0])?.key;
}

export interface ResolvedPick {
  cat: string | undefined;
  on: readonly string[];
  sort: SortKey | undefined;
}

/** Route choices → the effective ones, dropping anything this kind does not offer. */
export function resolvePick(
  config: KindConfig,
  pick: ListPick | undefined,
  sortBy: SortKey | undefined,
  model: ShowModel = showModel(config),
): ResolvedPick {
  const cat =
    pick?.cat !== undefined && model.categories.some((c) => c.id === pick.cat)
      ? pick.cat
      : defaultCategory(config, model);
  const known = new Set(model.toggles.map((t) => t.key));
  const on = (pick?.on ?? []).filter((k) => known.has(k));
  const sort = sortBy && config.list.sort.some((s) => s.key === sortBy) ? sortBy : defaultSort(config);
  return { cat, on, sort };
}

/** Effective choices → the minimal route value: defaults are left out of the address. */
export function pickForRoute(
  config: KindConfig,
  next: ResolvedPick,
  model: ShowModel = showModel(config),
): { pick?: ListPick; sortBy?: SortKey } {
  const pick: ListPick = {};
  if (next.cat !== defaultCategory(config, model)) pick.cat = next.cat ?? CAT_ALL;
  if (next.on.length > 0) pick.on = [...next.on];
  return {
    ...(Object.keys(pick).length > 0 ? { pick } : {}),
    ...(next.sort && next.sort !== defaultSort(config) ? { sortBy: next.sort } : {}),
  };
}

/** Flip one checkbox. Options of a single-select spec replace each other. */
export function toggleOn(model: ShowModel, on: readonly string[], key: string, multi: boolean): string[] {
  if (on.includes(key)) return on.filter((k) => k !== key);
  const specId = model.toggles.find((t) => t.key === key)?.specId;
  const kept = multi ? on : on.filter((k) => model.toggles.find((t) => t.key === k)?.specId !== specId);
  return [...kept, key];
}

function resolveViewer(filter: QueryFilter, viewerActorId: string): QueryFilter {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(filter as Record<string, unknown>)) {
    out[key] = Array.isArray(value)
      ? value.map((v) => (v === VIEWER ? viewerActorId : v))
      : value === VIEWER
        ? viewerActorId
        : value;
  }
  return out as QueryFilter;
}

/**
 * The read itself. `null` means the choices cannot all hold at once — the
 * caller says so and issues no query, exactly as the desktop band does.
 * With nothing chosen this is `{}`, the same unfiltered key the drawer's
 * counters and the desktop list read, so a first visit shares their cache.
 */
export function filterFor(
  config: KindConfig,
  resolved: ResolvedPick,
  viewerActorId: string | undefined,
  model: ShowModel = showModel(config),
): QueryFilter | null {
  const cat = model.categories.find((c) => c.id === resolved.cat)?.filter ?? null;
  const parts: QueryFilter[] = [];
  for (const key of resolved.on) {
    const toggle = model.toggles.find((t) => t.key === key);
    if (!toggle) continue;
    if (toggle.needsViewer) {
      if (!viewerActorId) continue;
      parts.push(resolveViewer(toggle.filter, viewerActorId));
    } else {
      parts.push(toggle.filter);
    }
  }
  return narrow(cat, ...parts);
}

/** "Filtered: Assigned to me · Include archived" — the one truncating line under search. */
export function activeLabels(model: ShowModel, resolved: ResolvedPick, config: KindConfig): string[] {
  const labels: string[] = [];
  if (resolved.cat !== defaultCategory(config, model)) {
    const c = model.categories.find((x) => x.id === resolved.cat);
    if (c) labels.push(c.label);
  }
  for (const key of resolved.on) {
    const t = model.toggles.find((x) => x.key === key);
    if (t) labels.push(t.label);
  }
  return labels;
}
