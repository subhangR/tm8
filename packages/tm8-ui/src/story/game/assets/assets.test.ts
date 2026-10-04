import { describe, expect, it } from 'vitest';
import { VIEW_OF_KIND, STORY_KIND, SESSION_KIND, TASK_KIND, UNMAPPED_ASSET_KINDS } from '../../model';
import type { Palette } from '../palette';
import {
  ASSET_OF_KIND, ASSET_SPECS, ENTITY_ASSET_TYPES, CONTAINER_ASSET_TYPES, assetStateOf, assetTypeOf, stateFor, type AssetType,
} from './registry';
import { ASSET_BUILDERS, KIT_BLOCKS, assetMetrics, buildAsset, buildBlock } from './prototypes';
import { KIT_SOLIDS } from './geometry';

const palette: Palette = { ink: 'rgb(20,20,20)', ink3: 'rgb(100,100,100)', surface: 'rgb(240,240,230)', card: 'rgb(255,255,255)', line: 'rgb(200,200,200)', line2: 'rgb(180,180,180)', brand: 'rgb(160,90,40)', run: 'rgb(50,140,80)', info: 'rgb(50,100,160)', block: 'rgb(180,70,60)', wait: 'rgb(180,150,40)', merged: 'rgb(120,80,160)' };
const ALL = Object.keys(ASSET_SPECS) as AssetType[];
const coreSignature = (type: AssetType, state: Parameters<typeof buildAsset>[2] extends infer O ? O extends { state?: infer S } ? S : never : never) => {
  const b = buildAsset(type, palette, { state, count: 2 });
  return b.parts.slice(0, b.core).map((p) => `${p.geo}:${p.x.toFixed(2)},${p.y.toFixed(2)},${p.z.toFixed(2)}`);
};

describe('kind → asset type registry', () => {
  it('maps every kind the story map renders, plus stories, to an explicit type', () => {
    for (const kind of [...Object.keys(VIEW_OF_KIND), STORY_KIND]) expect(ASSET_OF_KIND[kind], kind).toBeDefined();
  });
  it('gives each mapped kind its own type: nothing collapses into the task workshop', () => {
    const types = Object.values(ASSET_OF_KIND);
    expect(new Set(types).size).toBe(types.length);
    expect(Object.entries(ASSET_OF_KIND).filter(([, t]) => t === 'task-workshop').map(([k]) => k)).toEqual([TASK_KIND]);
  });
  it('sends unknown and unresolved kinds to the cairn, never to a building', () => {
    for (const kind of [...UNMAPPED_ASSET_KINDS, 'c:custom-thing']) expect(assetTypeOf({ kind, live: false })).toBe('unknown-cairn');
  });
  it('draws a robot only for a running session and a stele for an ended one', () => {
    expect(assetTypeOf({ kind: SESSION_KIND, live: true })).toBe('session-robot');
    expect(assetTypeOf({ kind: SESSION_KIND, live: false })).toBe('session-stele');
    expect(assetTypeOf({ kind: TASK_KIND, live: true })).toBe('task-workshop');
  });
  it('resolves roles: portal stories are gates, containers by role', () => {
    expect(assetTypeOf({ kind: STORY_KIND, live: false, role: 'hub' })).toBe('story-keep');
    expect(assetTypeOf({ kind: STORY_KIND, live: false, role: 'portal' })).toBe('story-gate');
    expect(assetTypeOf({ kind: TASK_KIND, live: false, role: 'taskLibrary' })).toBe('task-library');
    expect(assetTypeOf({ kind: TASK_KIND, live: false, role: 'mailbox' })).toBe('task-mailbox');
  });
  it('derives state from categories, never status names', () => {
    expect(assetStateOf({ statusCategory: 'in_progress' })).toBe('working');
    expect(assetStateOf({ statusCategory: 'in_progress', hasWorker: false })).toBe('planned');
    expect(assetStateOf({ statusCategory: 'in_progress', blocked: true })).toBe('blocked');
    expect(assetStateOf({ statusCategory: 'todo', waiting: true })).toBe('waiting');
    expect(assetStateOf({ statusCategory: 'done', blocked: true })).toBe('done');
    expect(assetStateOf({ statusCategory: 'cancelled' })).toBe('cancelled');
    expect(stateFor('session-robot', 'done')).not.toBe('done');
  });
  it('labels exploratory containers as proposals', () => {
    expect(ASSET_SPECS['task-code-shed'].decision).toBe('proposal');
    expect(ASSET_SPECS['mailbox-categories'].decision).toBe('proposal');
    expect(CONTAINER_ASSET_TYPES).toContain('story-library');
    expect(ENTITY_ASSET_TYPES).not.toContain('story-library');
  });
});

describe('asset builders', () => {
  it('has a builder for every type', () => {
    expect(Object.keys(ASSET_BUILDERS).sort()).toEqual([...ALL].sort());
  });
  it('builds every state deterministically within a bounded part budget', () => {
    for (const type of ALL) for (const state of ASSET_SPECS[type].states) {
      const a = buildAsset(type, palette, { state, count: 12, progress: .5 });
      expect(a.parts.length, `${type}/${state}`).toBeGreaterThan(0);
      expect(a.parts.length, `${type}/${state}`).toBeLessThanOrEqual(90);
      expect(buildAsset(type, palette, { state, count: 12, progress: .5 }).parts).toEqual(a.parts);
      for (const p of a.parts) expect(KIT_SOLIDS).toContain(p.geo);
    }
  });
  it('keeps the type core identical across states (type is not state)', () => {
    for (const type of ALL) {
      const [first, ...rest] = ASSET_SPECS[type].states;
      const core = coreSignature(type, first);
      expect(core.length, type).toBeGreaterThan(0);
      for (const s of rest) expect(coreSignature(type, s), `${type}/${s}`).toEqual(core);
    }
  });
  it('gives distinct entity types distinct core structures', () => {
    const seen = new Map<string, AssetType>();
    for (const type of ALL) {
      const sig = coreSignature(type, ASSET_SPECS[type].states[0]).join('|');
      expect(seen.get(sig), `${type} duplicates ${seen.get(sig)}`).toBeUndefined();
      seen.set(sig, type);
    }
  });
  it('takes every colour from the palette (silhouette mode overrides all)', () => {
    const flat = buildAsset('task-workshop', palette, { state: 'working', flat: 'rgb(1,2,3)' });
    expect(new Set(flat.parts.map((p) => p.color))).toEqual(new Set(['rgb(1,2,3)']));
  });
  it('reports layout metrics and sockets for buildings and containers', () => {
    const task = assetMetrics('task-workshop');
    expect(task.robotStand).not.toBeNull();
    expect(task.attach.left && task.attach.right && task.attach.back).toBeTruthy();
    expect(task.footprint.w).toBeLessThanOrEqual(2 * task.radius + .5);
    for (const t of ['story-library', 'story-code-factory', 'task-library', 'task-mailbox'] as const) expect(assetMetrics(t).badgeAnchor, t).not.toBeNull();
    expect(assetMetrics('session-robot').robotStand).toBeNull();
  });
  it('places parts relative to x/z and scale', () => {
    const a = buildAsset('doc-lectern', palette, {}), b = buildAsset('doc-lectern', palette, { x: 10, z: -4, scale: 2 });
    expect(b.parts[0]!.x).toBeCloseTo(10 + a.parts[0]!.x * 2);
    expect(b.parts[0]!.sx).toBeCloseTo(a.parts[0]!.sx * 2);
  });
  it('draws every kit block', () => {
    KIT_BLOCKS.forEach((_, i) => expect(buildBlock(i, palette, 0, 0).length).toBeGreaterThan(0));
  });
});
