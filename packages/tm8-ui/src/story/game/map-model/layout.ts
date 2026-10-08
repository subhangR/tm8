import { BoundsIndex } from './spatial-index';
import type { Bounds, LayoutCache, LayoutContainerCache, LayoutSlot, Point } from './types';
export interface LayoutNode {
  id: string; parentId: string | null; radius: number; group: string;
  title: string; order?: string;
}
export interface LaidOutNode extends LayoutNode, Point { depth: number; footprint: number; compoundBounds: Bounds }
export interface ForestLayout {
  nodes: LaidOutNode[]; cache: LayoutCache; bounds: Bounds; warnings: string[];
}
export const emptyBounds = (): Bounds => ({ minX: -8, minZ: -8, maxX: 8, maxZ: 8 });
export function boundsOf(nodes: readonly (Point & { footprint: number })[]): Bounds {
  if (!nodes.length) return emptyBounds();
  let minX = Infinity, minZ = Infinity, maxX = -Infinity, maxZ = -Infinity;
  for (const n of nodes) {
    minX = Math.min(minX, n.x - n.footprint); minZ = Math.min(minZ, n.z - n.footprint);
    maxX = Math.max(maxX, n.x + n.footprint); maxZ = Math.max(maxZ, n.z + n.footprint);
  }
  return { minX, minZ, maxX, maxZ };
}
const compare = (a: LayoutNode, b: LayoutNode) => a.group.localeCompare(b.group) || (b.order ?? '').localeCompare(a.order ?? '') || a.title.localeCompare(b.title) || a.id.localeCompare(b.id);

/** Iterative forest repair: absent/self parents become roots; a cycle loses its lexically first link. */
export function repairForest(input: readonly LayoutNode[]): { nodes: LayoutNode[]; warnings: string[] } {
  const warnings: string[] = [];
  const byId = new Map<string, LayoutNode>();
  for (const n of input) {
    if (byId.has(n.id)) { warnings.push(`Duplicate entity ${n.id} ignored`); continue; }
    byId.set(n.id, { ...n, radius: Number.isFinite(n.radius) ? Math.max(0.5, n.radius) : 2 });
  }
  for (const n of byId.values()) if (n.parentId && (!byId.has(n.parentId) || n.parentId === n.id)) {
    warnings.push(`Missing or self parent of ${n.id}; promoted to root`); n.parentId = null;
  }
  const settled = new Set<string>();
  for (const start of [...byId.keys()].sort()) {
    const path: string[] = [], positions = new Map<string, number>();
    let id: string | null = start;
    while (id && !settled.has(id)) {
      const previous = positions.get(id);
      if (previous !== undefined) {
        const root = path.slice(previous).sort()[0]!;
        byId.get(root)!.parentId = null; warnings.push(`Cycle broken at ${root}`); break;
      }
      positions.set(id, path.length); path.push(id); id = byId.get(id)!.parentId;
    }
    for (const item of path) settled.add(item);
  }
  return { nodes: [...byId.values()].sort(compare), warnings };
}

const GROUP_SHIFT = 6;
const HEX_Z = 3 * Math.sqrt(3) / 2;
const translate = (b: Bounds, x: number, z: number): Bounds => ({ minX: b.minX + x, maxX: b.maxX + x, minZ: b.minZ + z, maxZ: b.maxZ + z });
export function unionBounds(boxes: readonly Bounds[]): Bounds {
  if (!boxes.length) return emptyBounds();
  const result = { ...boxes[0]! };
  for (const b of boxes) { result.minX = Math.min(result.minX, b.minX); result.minZ = Math.min(result.minZ, b.minZ); result.maxX = Math.max(result.maxX, b.maxX); result.maxZ = Math.max(result.maxZ, b.maxZ); }
  return result;
}
function snap(x: number, z: number): Point {
  const r = Math.ceil(z / HEX_Z);
  return { x: Math.ceil(x / 3 - r / 2) * 3 + r * 1.5, z: r * HEX_Z };
}

/** Header + rectangular subtree parcels. Unary depth adds a row, never multiplies a circle. */
function allocate(nodes: LaidOutNode[], parentRadius: number, groupKeys: string[], old?: LayoutContainerCache): { cache: LayoutContainerCache; bounds: Bounds } {
  const keys = old ? [...old.groupKeys, ...groupKeys.filter(g => !old.groupKeys.includes(g))] : [...groupKeys];
  const shift = (group: string) => keys.indexOf(group) * GROUP_SHIFT;
  const reserveWidth = Math.max(0, keys.length - 1) * GROUP_SHIFT;
  const widths = nodes.map(n => n.compoundBounds.maxX - n.compoundBounds.minX + reserveWidth + 3);
  const area = nodes.reduce((sum, n, i) => sum + widths[i]! * (n.compoundBounds.maxZ - n.compoundBounds.minZ + 3), 0);
  const cache: LayoutContainerCache = {
    unit: 3, columns: old?.columns ?? Math.max(12, ...widths, Math.sqrt(area)), groupKeys: keys,
    slots: Object.create(null), vacant: [], next: { ...old?.next },
  };
  const index = new BoundsIndex(Math.max(12, Math.sqrt(area / Math.max(1, nodes.length))));
  if (parentRadius) index.insert({ id: '@parent', minX: -parentRadius, minZ: -parentRadius, maxX: parentRadius, maxZ: parentRadius });
  const active = new Map(nodes.map(n => [n.id, n]));
  cache.vacant = [...(old?.vacant ?? []), ...Object.values(old?.slots ?? {}).filter(s => active.get(s.id)?.group !== s.group)].map(s => ({ ...s }));
  const boxAt = (n: LaidOutNode, p: Point) => ({ id: n.id, ...translate(n.compoundBounds, p.x, p.z) });
  const retained = nodes.filter(n => old?.slots[n.id]?.group === n.group).sort((a, b) => Number(a.footprint > old!.slots[a.id]!.radius) - Number(b.footprint > old!.slots[b.id]!.radius) || compare(a, b));
  for (const n of retained) {
    const slot = old!.slots[n.id]!;
    if (!index.collides(boxAt(n, slot))) { cache.slots[n.id] = { ...slot, radius: n.footprint }; index.insert(boxAt(n, slot)); }
    else cache.vacant.push({ ...slot });
  }
  let cursorX = cache.next.x ?? 0, cursorZ = cache.next.z ?? (parentRadius ? parentRadius + 3 : 0), rowHeight = cache.next.height ?? 0;
  for (const n of nodes) {
    if (cache.slots[n.id]) continue;
    const reusable = cache.vacant.findIndex(s => s.group === n.group && !index.collides(boxAt(n, s)));
    let slot: LayoutSlot | undefined;
    const prior = old?.slots[n.id];
    if (!slot && prior && prior.group !== n.group) {
      const moved = { ...prior, group: n.group, x: prior.x + shift(n.group) - shift(prior.group), radius: n.footprint };
      if (!index.collides(boxAt(n, moved))) slot = moved;
    }
    if (!slot && reusable >= 0) slot = { ...cache.vacant.splice(reusable, 1)[0]!, id: n.id, radius: n.footprint };
    if (!slot) {
      const width = n.compoundBounds.maxX - n.compoundBounds.minX + reserveWidth + 3;
      const height = n.compoundBounds.maxZ - n.compoundBounds.minZ + 3;
      do {
        if (cursorX > 0 && cursorX + width > cache.columns) { cursorX = 0; cursorZ += rowHeight; rowHeight = 0; }
        const point = snap(cursorX - n.compoundBounds.minX + shift(n.group), cursorZ - n.compoundBounds.minZ);
        slot = { ...point, id: n.id, group: n.group, radius: n.footprint };
        cursorX += width + 3; rowHeight = Math.max(rowHeight, height + HEX_Z);
      } while (index.collides(boxAt(n, slot)));
    }
    cache.slots[n.id] = slot; index.insert(boxAt(n, slot));
  }
  cache.next = { x: cursorX, z: cursorZ, height: rowHeight };
  const boxes: Bounds[] = parentRadius ? [{ minX: -parentRadius, minZ: -parentRadius, maxX: parentRadius, maxZ: parentRadius }] : [];
  for (const n of nodes) {
    const slot = cache.slots[n.id]!; n.x = slot.x; n.z = slot.z;
    const base = translate(n.compoundBounds, slot.x - shift(n.group), slot.z);
    boxes.push({ ...base, maxX: base.maxX + reserveWidth });
  }
  if (old?.bounds) boxes.push(old.bounds);
  cache.bounds = unionBounds(boxes);
  return { cache, bounds: cache.bounds };
}

export function layoutForest(input: readonly LayoutNode[], options: { previous?: LayoutCache; groups?: readonly string[] } = {}): ForestLayout {
  const repaired = repairForest(input);
  const nodes = repaired.nodes.map(n => ({ ...n, x: 0, z: 0, depth: 0, footprint: n.radius, compoundBounds: { minX: -n.radius, minZ: -n.radius, maxX: n.radius, maxZ: n.radius } }));
  const children = new Map<string | null, LaidOutNode[]>();
  for (const n of nodes) { const siblings = children.get(n.parentId) ?? []; siblings.push(n); children.set(n.parentId, siblings); }
  const order: LaidOutNode[] = [], queue = [...(children.get(null) ?? [])];
  for (let i = 0; i < queue.length; i++) {
    const n = queue[i]!; order.push(n);
    for (const child of children.get(n.id) ?? []) { child.depth = n.depth + 1; queue.push(child); }
  }
  const cache: LayoutCache = { containers: Object.create(null) };
  const groups = [...new Set([...(options.groups ?? []), ...nodes.map(n => n.group).sort()])];
  for (let i = order.length - 1; i >= 0; i--) {
    const n = order[i]!, family = children.get(n.id);
    if (!family?.length) continue;
    const result = allocate(family, n.radius, groups, options.previous?.containers[n.id]);
    n.compoundBounds = result.bounds;
    n.footprint = Math.hypot(Math.max(Math.abs(result.bounds.minX), Math.abs(result.bounds.maxX)), Math.max(Math.abs(result.bounds.minZ), Math.abs(result.bounds.maxZ)));
    cache.containers[n.id] = result.cache;
  }
  const roots = children.get(null) ?? [];
  const rootResult = allocate(roots, 0, groups, options.previous?.containers['@roots']);
  cache.containers['@roots'] = rootResult.cache;
  const byId = new Map(nodes.map(n => [n.id, n]));
  for (const n of order) if (n.parentId) { const parent = byId.get(n.parentId)!; n.x += parent.x; n.z += parent.z; }
  for (const n of nodes) n.compoundBounds = translate(n.compoundBounds, n.x, n.z);
  return { nodes, cache, bounds: unionBounds(roots.map(n => n.compoundBounds)), warnings: repaired.warnings };
}
