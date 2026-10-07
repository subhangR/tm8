/**
 * Which kinds New creates at once (Kalai, 2026-10-07): the title-only ones.
 * The launcher kinds keep their own screens.
 */
import { describe, expect, it } from 'vitest';
import { allKinds, getKind } from '../../domain';
import { draftBodyFor } from './draft';

const INSTANT = ['task', 'doc', 'drawing', 'story', 'collection', 'channel'];

describe('instant create', () => {
  it('is exactly the title-only kinds, and they share one draft body', () => {
    const instant = allKinds().filter((config) => config.createInstant !== undefined).map((config) => config.kind);
    expect([...instant].sort()).toEqual([...INSTANT].sort());
    const bodies = new Set(INSTANT.map((kind) => draftBodyFor(kind)));
    expect(bodies.size).toBe(1);
    expect([...bodies][0]).toBeDefined();
  });

  it('a doc lands in its editor, every other instant kind on its title', () => {
    for (const kind of INSTANT) expect(getKind(kind).createInstant).toBe(kind === 'doc' ? 'editor' : 'title');
  });

  it('a session, a chat, a file and a skill keep their own create screens', () => {
    const instantBody = draftBodyFor('task');
    for (const kind of ['work_session', 'chat', 'file', 'skill']) expect(draftBodyFor(kind)).not.toBe(instantBody);
  });
});
