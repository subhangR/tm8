import { repairForest } from './layout';
import type { MapEntity } from './types';

export const isCancelledTask = (n: MapEntity): boolean => n.kind === 'task' && (n.status === 'cancelled' || (!n.status && n.statusCategory === 'cancelled'));
export const isDoneTask = (n: MapEntity): boolean => n.kind === 'task' && (n.status === 'done' || (!n.status && n.statusCategory === 'done'));
export interface TaskConstructionProgress {
  weight: number; subtreeWeight: number; progress: number | null;
  own: number | null; sizeBucket: number; estimateMissing: boolean;
}
export const taskSizeBucket = (weight: number): number => [1, 2, 3, 5, 8, 13].find(size => size >= weight) ?? 13;

/** Design Rules §9 over the admitted same-kind forest, including shipped children. */
export function taskConstructionProgress(entities: readonly MapEntity[], hierarchyComplete = false) {
  const tasks = new Map(entities.filter(n => n.kind === 'task').map(n => [n.id, n]));
  const forest = repairForest([...tasks.values()].map(n => ({
    id: n.id, parentId: n.parentId && tasks.has(n.parentId) ? n.parentId : null,
    radius: 1, group: '', title: n.title,
  })));
  const parentIds = new Map(forest.nodes.map(n => [n.id, n.parentId]));
  const children = new Map<string, string[]>();
  for (const n of forest.nodes) if (n.parentId) {
    const family = children.get(n.parentId) ?? [];
    family.push(n.id); children.set(n.parentId, family);
  }
  const order = forest.nodes.filter(n => !n.parentId).map(n => n.id);
  for (let i = 0; i < order.length; i++) order.push(...(children.get(order[i]!) ?? []));
  const byId = new Map<string, TaskConstructionProgress>();
  let projected = 0;
  for (let i = order.length - 1; i >= 0; i--) {
    const id = order[i]!, task = tasks.get(id)!, family = children.get(id) ?? [];
    const estimateMissing = task.pointsEstimate == null && task.estimateTent !== false;
    // Summary rows hide estimates. A tent=false row permits recovering own
    // weight from authoritative subtree size minus immediate-child sizes.
    // Bounded hierarchies remain approximate and retain their source warning.
    const hiddenEstimate = task.pointsEstimate == null && task.estimateTent === false;
    const projectedWeight = hiddenEstimate && hierarchyComplete && task.subtreeWeight != null
      ? task.subtreeWeight - family.reduce((sum, child) => sum + (isCancelledTask(tasks.get(child)!) ? 0 : tasks.get(child)!.subtreeWeight ?? byId.get(child)!.subtreeWeight), 0)
      : undefined;
    if (projectedWeight !== undefined && projectedWeight < 0) forest.warnings.push(`Inconsistent projected subtree weights for ${id}; own weight is unknown`);
    const estimate = task.pointsEstimate ?? projectedWeight ?? 1;
    const weight = Number.isFinite(estimate) && estimate >= 0 ? estimate : 1;
    const fallback = hiddenEstimate && (!hierarchyComplete || projectedWeight === undefined || projectedWeight < 0);
    if (fallback) projected++;
    const subtreeWeight = isCancelledTask(task) ? 0 : fallback && task.subtreeWeight != null ? task.subtreeWeight
      : weight + family.reduce((sum, child) => sum + byId.get(child)!.subtreeWeight, 0);
    const criteria = task.acceptance;
    const hasCriteria = criteria !== undefined && criteria.total > 0;
    const own = isCancelledTask(task) ? null : hasCriteria
      ? Math.max(0, Math.min(1, criteria!.completed / criteria!.total))
      : family.length ? null : isDoneTask(task) ? 1 : 0;
    const ownWeight = own === null ? 0 : weight;
    const childWeight = family.reduce((sum, child) => sum + byId.get(child)!.subtreeWeight, 0);
    const earned = ownWeight * (own ?? 0) + family.reduce((sum, child) => {
      const rolled = byId.get(child)!;
      return sum + rolled.subtreeWeight * (rolled.progress ?? 0);
    }, 0);
    const progress = isCancelledTask(task) ? null : isDoneTask(task) ? 1 : fallback && task.progress != null ? task.progress
      : ownWeight + childWeight > 0 ? earned / (ownWeight + childWeight) : own ?? 0;
    byId.set(id, { weight, subtreeWeight, progress, own, estimateMissing, sizeBucket: taskSizeBucket(subtreeWeight) });
  }
  return { byId, parentIds, warnings: [...forest.warnings, ...(projected ? [
    `${projected} task(s) hide their estimate in an incomplete hierarchy; authoritative aggregate progress/size is a fallback, not an exact Design Rules calculation`,
  ] : [])] };
}
