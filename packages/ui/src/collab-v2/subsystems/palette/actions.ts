/**
 * Palette action registry — every operation the mouse can do, expressed as a
 * keyboard-executable row.
 *
 * Two sources merge here:
 *  1. `facade.getActions(contextEntityId)` — the backend's context-aware list
 *     (create / navigate / link / pull / status), mapped onto real steps.
 *  2. This local registry — the rest of the graph grammar: go-to for every
 *     view, create for every creatable kind, link A→B with an edge-type
 *     picker, panel open/pin/promote, re-pull, mark read.
 *
 * Executors are plain async functions taking `PaletteDeps`, so they're
 * testable without a DOM and identical for click and Enter.
 */
import { kindCan, paletteCreatableKinds, registryFor } from '../../registry';
import { VIEWS, type ViewName } from '../../stores/nav';
import {
  isCollabError, type EntityId, type EntityKind, type EntitySummary,
  type PaletteAction, type WorkStatus,
} from '../../types/contract';
import type {
  EdgeTypeChoice, PaletteDeps, PaletteItem, PaletteMode,
  StatusChoice, ViewChoice,
} from './types';

// --- static choice tables -----------------------------------------------------

const VIEW_LABELS: Record<ViewName, string> = {
  home: 'Home', tasks: 'Tasks', docs: 'Docs', team: 'Team', tracking: 'Tracking',
  graph: 'Graph', leaderboard: 'Leaderboard', inbox: 'Inbox', settings: 'Settings',
  sessions: 'Sessions', channel: 'Channel', entity: 'Entity',
};

/**
 * Views reachable as a destination. `channel` and `entity` need an entity to
 * focus, so they are not bare jumps. `sessions` IS a bare jump — it opens the
 * list, and focusing one session is a further step from there.
 */
export const VIEW_CHOICES: ViewChoice[] = VIEWS
  .filter((v): v is Exclude<ViewName, 'channel' | 'entity'> => v !== 'channel' && v !== 'entity')
  .map((view) => ({ view, label: VIEW_LABELS[view], keywords: `go to ${VIEW_LABELS[view]}` }));

/**
 * Edge types offered by the picker. Mirrors the mock's registered grammar; the
 * facade validates the src/dst kinds and rejects with `invalid_input`, which
 * the palette surfaces verbatim rather than second-guessing here.
 */
export const EDGE_TYPE_CHOICES: EdgeTypeChoice[] = [
  { type: 'depends_on', label: 'Depends on', hint: 'blocks until resolved' },
  { type: 'assigned_to', label: 'Assigned to', hint: 'task → member / agent' },
  { type: 'attached_to', label: 'Attached to', hint: 'entity → channel / hub' },
  { type: 'tracks', label: 'Tracks', hint: 'task → PR / commit' },
  { type: 'equips', label: 'Equips', hint: 'task / agent → spell / skill' },
  { type: 'relates_to', label: 'Related to', hint: 'soft link, both ways' },
  { type: 'copy_of', label: 'Copy of', hint: 'derived from' },
];

/** Custom edge types must be namespaced `x:` (contract rule). */
export function customEdgeType(raw: string): string | null {
  const t = raw.trim().replace(/\s+/g, '_').toLowerCase();
  if (!t) return null;
  return t.startsWith('x:') ? t : `x:${t}`;
}

/** `done` is deliberately absent — completion goes through Complete task. */
export const STATUS_CHOICES: StatusChoice[] = [
  { status: 'open', label: 'Open' },
  { status: 'pulled', label: 'Pulled' },
  { status: 'working', label: 'Working' },
  { status: 'in_review', label: 'In review' },
  { status: 'blocked', label: 'Blocked' },
  { status: 'cancelled', label: 'Cancelled' },
];

// --- error surface (DEV-8: switch on code, never on message text) -------------

export function describeError(e: unknown): string {
  if (isCollabError(e)) {
    switch (e.code) {
      case 'version_conflict': return 'Someone changed this first — reopen and retry.';
      case 'forbidden': return 'You do not have permission for that.';
      case 'not_found': return 'That entity no longer exists.';
      case 'invalid_input': return e.message;
      default: return e.message;
    }
  }
  return e instanceof Error ? e.message : 'Something went wrong.';
}

// --- executors ----------------------------------------------------------------

async function guard(deps: PaletteDeps, fn: () => Promise<void>): Promise<void> {
  try {
    await fn();
  } catch (e) {
    deps.notify({ kind: 'error', message: describeError(e) });
  }
}

export async function runPull(deps: PaletteDeps, entityId: EntityId, repull = false): Promise<void> {
  await guard(deps, async () => {
    const detail = await deps.facade.getEntity(entityId);
    await deps.facade.pullEntity(entityId, { pinnedVersion: detail.version });
    deps.notify({
      kind: 'success',
      message: `${repull ? 'Re-pulled' : 'Pulled'} ${detail.title} at v${detail.version}`,
    });
    deps.onExecuted?.({ itemId: repull ? 'repull' : 'pull', category: 'pull', entityId, detail: { pinnedVersion: detail.version } });
    deps.close();
  });
}

export async function runSetStatus(deps: PaletteDeps, entityId: EntityId, status: WorkStatus): Promise<void> {
  await guard(deps, async () => {
    const detail = await deps.facade.getEntity(entityId);
    await deps.facade.patchTask(entityId, { expectedVersion: detail.version, workStatus: status });
    deps.notify({ kind: 'success', message: `${detail.title} → ${status.replace('_', ' ')}` });
    deps.onExecuted?.({ itemId: `status:${status}`, category: 'status', entityId, detail: { status } });
    deps.close();
  });
}

export async function runComplete(deps: PaletteDeps, entityId: EntityId): Promise<void> {
  await guard(deps, async () => {
    const detail = await deps.facade.getEntity(entityId);
    const assignees = detail.state.kind === 'task' ? detail.state.assignees : [];
    const completerIds = assignees.length > 0
      ? assignees.map((a) => a.id)
      : [detail.createdBy.id];
    await deps.facade.completeTask(entityId, { expectedVersion: detail.version, completerIds });
    deps.notify({ kind: 'success', message: `Completed ${detail.title}` });
    deps.onExecuted?.({ itemId: 'complete', category: 'status', entityId, detail: { completerIds } });
    deps.close();
  });
}

export async function runCreate(
  deps: PaletteDeps,
  kind: EntityKind,
  title: string,
  parentId?: EntityId | null,
): Promise<void> {
  const clean = title.trim();
  if (!deps.spaceId) {
    deps.notify({ kind: 'error', message: 'No space is open.' });
    return;
  }
  if (!clean) {
    deps.notify({ kind: 'error', message: 'Type a title, then press Enter.' });
    return;
  }
  // Creation dispatch is registry DATA (DEF-10): the entry owns the canonical
  // `createEntity` call (DEV-1), so the palette never branches per kind.
  const entry = registryFor(kind);
  const createVia = entry.createVia;
  if (!createVia) {
    deps.notify({
      kind: 'error',
      message: entry.creationDisabledReason ?? `${entry.labelPlural} cannot be created here.`,
    });
    return;
  }
  await guard(deps, async () => {
    const spaceId = deps.spaceId as string;
    const attachTo = parentId ? { entityId: parentId, edgeType: 'attached_to' as const } : undefined;
    const result = await createVia(deps.facade, { spaceId, title: clean, attachTo });
    const created = result.entity;
    deps.notify({ kind: 'success', message: `Created ${clean}` });
    deps.onExecuted?.({
      itemId: `create:${kind}`, category: 'create', entityId: created?.id,
      detail: { kind, title: clean, parentId: parentId ?? null },
    });
    deps.close();
    if (created) deps.nav.pushPanel({ entityId: created.id });
  });
}

export async function runLink(
  deps: PaletteDeps, sourceId: EntityId, targetId: EntityId, type: string,
): Promise<void> {
  await guard(deps, async () => {
    await deps.facade.createEdge({ srcId: sourceId, dstId: targetId, type });
    deps.notify({ kind: 'success', message: `Linked · ${type.replace('x:', '')}` });
    deps.onExecuted?.({
      itemId: `link:${type}`, category: 'link', entityId: sourceId,
      detail: { sourceId, targetId, type },
    });
    deps.close();
  });
}

export function runGoTo(deps: PaletteDeps, view: ViewName): void {
  deps.nav.setView(view);
  deps.onExecuted?.({ itemId: `goto:${view}`, category: 'navigate', detail: { view } });
  deps.close();
}

export function runOpenEntity(deps: PaletteDeps, entity: EntitySummary): void {
  deps.nav.pushPanel({ entityId: entity.id });
  deps.onExecuted?.({ itemId: `open:${entity.id}`, category: 'open', entityId: entity.id });
  deps.close();
}

async function runMarkRead(deps: PaletteDeps, entityId: EntityId): Promise<void> {
  await guard(deps, async () => {
    await deps.facade.markRead(entityId);
    deps.notify({ kind: 'success', message: 'Marked read' });
    deps.onExecuted?.({ itemId: 'mark-read', category: 'read', entityId });
    deps.close();
  });
}

// --- step (mode) rows ----------------------------------------------------------

function step(deps: PaletteDeps, id: string, label: string, mode: PaletteMode, opts: {
  section: string; hint?: string; glyph?: string; keywords?: string; entity?: EntitySummary;
}): PaletteItem {
  return {
    id, label, group: 'action', section: opts.section, hint: opts.hint,
    glyph: opts.glyph, keywords: opts.keywords, entity: opts.entity,
    run: () => {
      deps.setMode(mode);
      deps.resetQuery();
      deps.onExecuted?.({ itemId: id, category: 'step', detail: { mode: mode.kind } });
    },
  };
}

// --- builders -----------------------------------------------------------------

/**
 * Map a facade `PaletteAction` onto a real palette row. Unknown ids degrade
 * gracefully: anything carrying a target entity becomes "open it".
 */
export function itemForFacadeAction(deps: PaletteDeps, action: PaletteAction): PaletteItem | null {
  const target = action.targetEntityId;
  const section = 'Context actions';
  switch (action.kind) {
    case 'navigate': {
      const view = VIEW_CHOICES.find((v) => action.id === `go-${v.view}`)?.view;
      if (view) {
        return {
          id: action.id, label: action.label, group: 'action', section: 'Go to',
          glyph: '→', keywords: `go to ${view}`,
          run: () => runGoTo(deps, view),
        };
      }
      if (!target) return null;
      const entity = deps.known.find((e) => e.id === target);
      return {
        id: action.id, label: action.label, group: 'action', section, glyph: '→', entity,
        run: () => (entity ? runOpenEntity(deps, entity) : deps.nav.pushPanel({ entityId: target })),
      };
    }
    case 'create':
      return step(deps, action.id, action.label, { kind: 'create', entityKind: 'task', parentId: target ?? null }, {
        section: target ? section : 'Create', glyph: '+', keywords: 'new task add',
      });
    case 'link':
      if (!target) return null;
      return step(deps, action.id, action.label, { kind: 'link-target', sourceId: target }, {
        section, glyph: '⇄', keywords: 'link edge connect relate depends',
      });
    case 'pull':
      if (!target) return null;
      return {
        id: action.id, label: action.label, group: 'action', section, glyph: '⤓',
        keywords: 'pull work take',
        run: () => runPull(deps, target),
      };
    case 'status': {
      if (!target) return null;
      if (action.id.startsWith('complete-')) {
        return {
          id: action.id, label: action.label, group: 'action', section, glyph: '✓',
          keywords: 'complete done finish award',
          run: () => runComplete(deps, target),
        };
      }
      return step(deps, action.id, action.label, { kind: 'status', targetId: target }, {
        section, glyph: '◑', keywords: 'status working review blocked',
      });
    }
    default:
      if (!target) return null;
      return {
        id: action.id, label: action.label, group: 'action', section, glyph: '•',
        run: () => deps.nav.pushPanel({ entityId: target }),
      };
  }
}

/** Local rows that exist regardless of what the facade offers. */
export function buildLocalActions(deps: PaletteDeps): PaletteItem[] {
  const items: PaletteItem[] = [];
  const ctx = deps.contextEntity;

  // Context rows first — the palette is context-aware by design.
  if (ctx) {
    items.push({
      id: 'ctx-open', label: `Open ${ctx.title} in a panel`, group: 'action',
      section: 'Context actions', glyph: '▤', entity: ctx, keywords: 'open panel peek',
      run: () => runOpenEntity(deps, ctx),
    });
    items.push({
      id: 'ctx-pin', label: `Pin ${ctx.title} as a split`, group: 'action',
      section: 'Context actions', glyph: '📌', keywords: 'pin split dock',
      run: () => {
        const ok = deps.nav.pinPanel(ctx.id);
        deps.notify(ok
          ? { kind: 'success', message: `Pinned ${ctx.title}` }
          : { kind: 'error', message: 'Pin limit reached (3 splits).' });
        deps.onExecuted?.({ itemId: 'ctx-pin', category: 'panel', entityId: ctx.id, detail: { ok } });
        if (ok) deps.close();
      },
    });
    items.push({
      id: 'ctx-promote', label: `Open ${ctx.title} full view`, group: 'action',
      section: 'Context actions', glyph: '⤢', keywords: 'promote expand full',
      run: () => {
        deps.nav.promotePanel(ctx.id);
        deps.onExecuted?.({ itemId: 'ctx-promote', category: 'panel', entityId: ctx.id });
        deps.close();
      },
    });
    items.push(step(deps, 'ctx-create-in', `Create in ${ctx.title}…`,
      { kind: 'create', entityKind: 'task', parentId: ctx.id },
      { section: 'Context actions', glyph: '+', keywords: 'create task inside child add' }));
    if (ctx.badges.pulls?.some((p) => p.contentStale || p.discussionMoved)) {
      items.push({
        id: 'ctx-repull', label: `Re-pull ${ctx.title} (refresh context)`, group: 'action',
        section: 'Context actions', glyph: '⟳', keywords: 'repull refresh stale',
        run: () => runPull(deps, ctx.id, true),
      });
    }
    // Which kinds anchor an unread scope is registry data (DEF-11).
    if (kindCan(ctx.kind, 'markReadAnchor')) {
      items.push({
        id: 'ctx-mark-read', label: `Mark ${ctx.title} read`, group: 'action',
        section: 'Context actions', glyph: '✉', keywords: 'read unread clear',
        run: () => runMarkRead(deps, ctx.id),
      });
    }
  }

  // Creation — one row per palette-creatable kind, straight from the registry
  // (DEF-10). Enter → type a title → Enter.
  for (const entry of paletteCreatableKinds()) {
    items.push(step(deps, `create-${entry.kind}`, `Create ${entry.label}…`,
      { kind: 'create', entityKind: entry.kind, parentId: ctx?.id ?? null },
      { section: 'Create', glyph: '+', keywords: entry.paletteCreate?.keywords }));
  }

  // Link, from the context entity when there is one.
  if (ctx) {
    items.push(step(deps, 'link-from-ctx', `Link ${ctx.title} to…`,
      { kind: 'link-target', sourceId: ctx.id },
      { section: 'Graph', glyph: '⇄', keywords: 'link edge connect depends attach assign' }));
  }

  // Go to — every primary view, always keyboard-reachable.
  items.push(step(deps, 'goto', 'Go to…', { kind: 'goto' }, {
    section: 'Go to', glyph: '→', keywords: 'goto jump navigate view',
  }));
  for (const v of VIEW_CHOICES) {
    items.push({
      id: `goto-${v.view}`, label: `Go to ${v.label}`, group: 'action', section: 'Go to',
      glyph: '→', keywords: v.keywords, hint: `g ${v.view[0]}`,
      run: () => runGoTo(deps, v.view),
    });
  }

  return items;
}

/** Root rows = facade context actions (deduped) + the local registry. */
export function buildRootItems(deps: PaletteDeps, facadeActions: PaletteAction[]): PaletteItem[] {
  const mapped = facadeActions
    .map((a) => itemForFacadeAction(deps, a))
    .filter((i): i is PaletteItem => i != null);
  const seen = new Set(mapped.map((i) => i.id));
  const local = buildLocalActions(deps).filter((i) => !seen.has(i.id));
  return [...mapped, ...local];
}

export function buildGotoItems(deps: PaletteDeps): PaletteItem[] {
  return VIEW_CHOICES.map((v) => ({
    id: `goto-${v.view}`, label: v.label, group: 'choice' as const, section: 'Go to',
    glyph: '→', keywords: v.keywords, hint: `g ${v.view[0]}`,
    run: () => runGoTo(deps, v.view),
  }));
}

export function buildStatusItems(deps: PaletteDeps, targetId: EntityId): PaletteItem[] {
  const rows: PaletteItem[] = STATUS_CHOICES.map((c) => ({
    id: `status-${c.status}`, label: c.label, group: 'choice' as const, section: 'Set status',
    glyph: '◑', keywords: c.status,
    run: () => runSetStatus(deps, targetId, c.status),
  }));
  rows.push({
    id: 'status-complete', label: 'Complete task…', group: 'choice', section: 'Set status',
    glyph: '✓', hint: 'awards points', keywords: 'done complete finish',
    run: () => runComplete(deps, targetId),
  });
  return rows;
}

export function buildLinkTypeItems(
  deps: PaletteDeps, sourceId: EntityId, targetId: EntityId,
): PaletteItem[] {
  const rows: PaletteItem[] = EDGE_TYPE_CHOICES.map((c) => ({
    id: `edge-${c.type}`, label: c.label, group: 'choice' as const, section: 'Edge type',
    glyph: '⇄', hint: c.hint, keywords: c.type,
    run: () => runLink(deps, sourceId, targetId, c.type),
  }));
  const custom = customEdgeType(deps.query);
  if (custom && !EDGE_TYPE_CHOICES.some((c) => c.type === custom)) {
    rows.push({
      id: 'edge-custom', label: `Custom edge “${custom}”`, group: 'choice', section: 'Edge type',
      glyph: '✎', hint: 'namespaced x:*',
      run: () => runLink(deps, sourceId, targetId, custom),
    });
  }
  return rows;
}

export function buildCreateItems(
  deps: PaletteDeps, kind: EntityKind, parentId?: EntityId | null,
): PaletteItem[] {
  const title = deps.query.trim();
  const parent = parentId ? deps.known.find((e) => e.id === parentId) : undefined;
  return [{
    id: `create-confirm-${kind}`,
    label: title ? `Create ${kind} “${title}”` : `Type a title for the new ${kind}…`,
    group: 'choice', section: 'Create',
    glyph: '+',
    hint: parent ? `in ${parent.title}` : undefined,
    run: () => runCreate(deps, kind, title, parentId),
  }];
}

/** Recent/known entity rows (no search — STATE.md ⚠ contract update). */
export function buildEntityItems(
  deps: PaletteDeps,
  entities: EntitySummary[],
  opts: { section?: string; onPick?: (entity: EntitySummary) => void } = {},
): PaletteItem[] {
  const section = opts.section ?? 'Recent & known';
  return entities.map((entity) => ({
    id: `entity-${entity.id}`,
    label: entity.title,
    group: 'entity' as const,
    section,
    entity,
    keywords: `${entity.kind} ${entity.excerpt ?? ''}`,
    run: () => (opts.onPick ? opts.onPick(entity) : runOpenEntity(deps, entity)),
  }));
}

// --- query filtering (local only — this is NOT search) -------------------------

const KIND_TOKEN = /^kind:([a-z_]+)\s*/i;

/** Split a leading `kind:task ` token off the query. */
export function parseQuery(raw: string): { text: string; kinds: EntityKind[] } {
  let rest = raw;
  const kinds: EntityKind[] = [];
  let m = KIND_TOKEN.exec(rest);
  while (m) {
    kinds.push(m[1].toLowerCase() as EntityKind);
    rest = rest.slice(m[0].length);
    m = KIND_TOKEN.exec(rest);
  }
  return { text: rest, kinds };
}

export function matchesQuery(item: PaletteItem, text: string): boolean {
  const needle = text.trim().toLowerCase();
  if (!needle) return true;
  const hay = `${item.label} ${item.hint ?? ''} ${item.keywords ?? ''} ${item.entity?.title ?? ''}`.toLowerCase();
  return needle.split(/\s+/).every((token) => hay.includes(token));
}
