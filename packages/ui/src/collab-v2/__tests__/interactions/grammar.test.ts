/**
 * The grammar table — all 7 rows resolve to the right placements intent,
 * ghost labels preview the meaning, ambiguity never exceeds 3 options.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import {
  GRAMMAR_TABLE, MAX_DROP_OPTIONS, resolveDrop, rowFor, sourceRef,
  surfaceForEntity, targetRef,
} from '../../interactions';
import type { DropSurfaceKind } from '../../interactions';
import type { EntitySummary } from '../../types/contract';
import { createRig, resetStores, type InteractionRig } from './helpers';

let rig: InteractionRig;
const s = (id: string): Promise<EntitySummary> => rig.facade.getEntity(id);

beforeEach(() => {
  resetStores();
  rig = createRig();
});

describe('grammar table shape', () => {
  it('has exactly the 7 prototype rows, as data', () => {
    expect(GRAMMAR_TABLE.map((r) => r.id)).toEqual([
      'chip-to-channel',
      'task-to-task',
      'artifact-to-task',
      'actor-to-task',
      'task-to-actor',
      'chip-to-composer',
      'same-kind-to-parent-zone',
    ]);
  });

  it('never offers more than 3 options on any row (seed-wide sweep)', async () => {
    const ids = rig.ids;
    const all = await Promise.all([
      s(ids.chBuild), s(ids.t103), s(ids.t106), s(ids.docSpec), s(ids.fileWireframes),
      s(ids.spellReviewer), s(ids.subhang), s(ids.forge), s(ids.commitA1),
    ]);
    const surfaces: DropSurfaceKind[] = ['channel', 'task', 'actor', 'composer', 'parent-zone'];
    for (const source of all) {
      for (const target of all) {
        for (const surface of surfaces) {
          const options = resolveDrop(sourceRef(source), targetRef(target, surface));
          expect(options.length).toBeLessThanOrEqual(MAX_DROP_OPTIONS);
        }
      }
    }
  });
});

describe('the 7 rows resolve to the right intent (table-driven)', () => {
  interface Case {
    name: string;
    source: () => Promise<EntitySummary>;
    target: () => Promise<EntitySummary>;
    surface: DropSurfaceKind;
    rowId: string;
    intents: string[];
    ghost: (src: EntitySummary, tgt: EntitySummary) => string;
  }

  const cases: Case[] = [
    {
      name: 'row 1 — any chip → channel = attach (+ optional embed)',
      source: () => s(rig.ids.docSpec),
      target: () => s(rig.ids.chBuild),
      surface: 'channel',
      rowId: 'chip-to-channel',
      intents: ['attach', 'attach'],
      ghost: (_src, tgt) => `Attach to #${tgt.title}`,
    },
    {
      name: 'row 2 — doc → task = attach',
      source: () => s(rig.ids.docSpec),
      target: () => s(rig.ids.t103),
      surface: 'task',
      rowId: 'artifact-to-task',
      intents: ['attach'],
      ghost: (_src, tgt) => `Attach to ${tgt.title}`,
    },
    {
      name: 'row 3 — team_member → task = assign',
      source: () => s(rig.ids.forge),
      target: () => s(rig.ids.t103),
      surface: 'task',
      rowId: 'actor-to-task',
      intents: ['assign'],
      ghost: (src) => `Assign to ${src.title}`,
    },
    {
      name: 'row 4 — task → task = attach | depend | subtask (3-zone menu)',
      source: () => s(rig.ids.t106),
      target: () => s(rig.ids.t103),
      surface: 'task',
      rowId: 'task-to-task',
      intents: ['attach', 'depend', 'subtask'],
      ghost: (_src, tgt) => `Attach to ${tgt.title}`,
    },
    {
      name: 'row 5 — task → member = assign',
      source: () => s(rig.ids.t106),
      target: () => s(rig.ids.subhang),
      surface: 'actor',
      rowId: 'task-to-actor',
      intents: ['assign'],
      ghost: (src) => `Assign ${src.title}`,
    },
    {
      name: 'row 6 — any chip → composer = embed',
      source: () => s(rig.ids.spellReviewer),
      target: () => s(rig.ids.chBuild),
      surface: 'composer',
      rowId: 'chip-to-composer',
      intents: ['embed'],
      ghost: (src) => `Embed ${src.title}`,
    },
    {
      name: 'row 7 — same-kind → parent-zone = reparent',
      source: () => s(rig.ids.t103a),
      target: () => s(rig.ids.t104),
      surface: 'parent-zone',
      rowId: 'same-kind-to-parent-zone',
      intents: ['reparent'],
      ghost: (_src, tgt) => `Move into ${tgt.title}`,
    },
  ];

  for (const c of cases) {
    it(c.name, async () => {
      const source = await c.source();
      const target = await c.target();
      const src = sourceRef(source);
      const tgt = targetRef(target, c.surface);
      expect(rowFor(src, tgt)?.id).toBe(c.rowId);
      const options = resolveDrop(src, tgt);
      expect(options.map((o) => o.intent)).toEqual(c.intents);
      expect(options[0].ghost).toBe(c.ghost(source, target));
    });
  }

  it('row 4 depend ghost states the real arrow: TARGET depends on SOURCE', async () => {
    const source = await s(rig.ids.t106);
    const target = await s(rig.ids.t103);
    const options = resolveDrop(sourceRef(source), targetRef(target, 'task'));
    const depend = options.find((o) => o.intent === 'depend');
    expect(depend?.ghost).toBe(`${target.title} depends on ${source.title}`);
  });

  it('row 1 second option carries the embed variant', async () => {
    const source = await s(rig.ids.docSpec);
    const target = await s(rig.ids.chBuild);
    const options = resolveDrop(sourceRef(source), targetRef(target, 'channel'));
    expect(options).toHaveLength(2);
    expect(options[1].withEmbed).toBe(true);
  });
});

describe('rejections and precedence', () => {
  it('rejects a self-drop on every surface', async () => {
    const t = await s(rig.ids.t103);
    for (const surface of ['channel', 'task', 'actor', 'composer', 'parent-zone'] as const) {
      expect(resolveDrop(sourceRef(t), targetRef(t, surface))).toEqual([]);
    }
  });

  it('rejects sources with no row on the surface (commit → task)', async () => {
    const commit = await s(rig.ids.commitA1);
    const task = await s(rig.ids.t103);
    expect(resolveDrop(sourceRef(commit), targetRef(task, 'task'))).toEqual([]);
  });

  it('rejects cross-kind parent-zone drops (doc → task parent-zone)', async () => {
    const doc = await s(rig.ids.docSpec);
    const task = await s(rig.ids.t103);
    expect(resolveDrop(sourceRef(doc), targetRef(task, 'parent-zone'))).toEqual([]);
  });

  it('task→task precedence beats the artifact row (3 options, not 1)', async () => {
    const a = await s(rig.ids.t106);
    const b = await s(rig.ids.t103);
    expect(resolveDrop(sourceRef(a), targetRef(b, 'task'))).toHaveLength(3);
  });

  it('surfaceForEntity derives task/actor/channel and null elsewhere', async () => {
    expect(surfaceForEntity(await s(rig.ids.t103))).toBe('task');
    expect(surfaceForEntity(await s(rig.ids.subhang))).toBe('actor');
    expect(surfaceForEntity(await s(rig.ids.forge))).toBe('actor');
    expect(surfaceForEntity(await s(rig.ids.chBuild))).toBe('channel');
    expect(surfaceForEntity(await s(rig.ids.docSpec))).toBeNull();
  });
});
