import type { Point } from './types';
export interface Circle extends Point { id: string; radius: number }
/** Uniform spatial hash. Broad phase visits intersecting cells; exact phase uses circles. */
export class SpatialIndex {
  private cells = new Map<string, Circle[]>();
  constructor(readonly cellSize = 16) {
    if (!Number.isFinite(cellSize) || cellSize <= 0) throw new Error('Invalid cell size');
  }
  private keys(circle: Circle): string[] {
    const keys: string[] = [];
    for (let x = Math.floor((circle.x - circle.radius) / this.cellSize); x <= Math.floor((circle.x + circle.radius) / this.cellSize); x++) {
      for (let z = Math.floor((circle.z - circle.radius) / this.cellSize); z <= Math.floor((circle.z + circle.radius) / this.cellSize); z++) keys.push(`${x}:${z}`);
    }
    return keys;
  }
  insert(circle: Circle): void {
    for (const key of this.keys(circle)) {
      const bucket = this.cells.get(key);
      if (bucket) bucket.push(circle); else this.cells.set(key, [circle]);
    }
  }
  collides(circle: Circle, gap = 0): boolean {
    const seen = new Set<string>();
    for (const key of this.keys({ ...circle, radius: circle.radius + gap })) {
      for (const other of this.cells.get(key) ?? []) {
        if (other.id === circle.id || seen.has(other.id)) continue;
        seen.add(other.id);
        if (Math.hypot(circle.x - other.x, circle.z - other.z) < circle.radius + other.radius + gap - 1e-8) return true;
      }
    }
    return false;
  }
}

export interface IndexedBounds { id: string; minX: number; minZ: number; maxX: number; maxZ: number }
/** Rectangular compound broad phase: deep shapes do not pay for empty bounding circles. */
export class BoundsIndex {
  private cells = new Map<string, IndexedBounds[]>();
  constructor(private cellSize = 24) {}
  private keys(b: IndexedBounds): string[] {
    const keys: string[] = [];
    for (let x = Math.floor(b.minX / this.cellSize); x <= Math.floor(b.maxX / this.cellSize); x++)
      for (let z = Math.floor(b.minZ / this.cellSize); z <= Math.floor(b.maxZ / this.cellSize); z++) keys.push(`${x}:${z}`);
    return keys;
  }
  insert(b: IndexedBounds): void {
    for (const key of this.keys(b)) { const bucket = this.cells.get(key); if (bucket) bucket.push(b); else this.cells.set(key, [b]); }
  }
  collides(b: IndexedBounds, gap = 1): boolean {
    const search = { ...b, minX: b.minX - gap, minZ: b.minZ - gap, maxX: b.maxX + gap, maxZ: b.maxZ + gap };
    for (const key of this.keys(search)) for (const other of this.cells.get(key) ?? [])
      if (other.id !== b.id && search.minX < other.maxX - 1e-8 && search.maxX > other.minX + 1e-8 && search.minZ < other.maxZ - 1e-8 && search.maxZ > other.minZ + 1e-8) return true;
    return false;
  }
}
