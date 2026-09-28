import { describe, expect, it } from 'vitest';
import { EDGE_KINDS, relationsOf } from './edge-kinds';
import { EDGE_VERBS } from './edge-verbs';
import { allKinds } from './registry';

/**
 * `EDGE_KINDS` and `EDGE_VERBS` are two halves of the same registry rows, and
 * `edge-verbs.test.ts` already holds the verb map to the migrations. Holding
 * the kinds map to the verb map therefore holds it to the migrations too — a
 * new edge type that lands without endpoint kinds here fails, and a type the
 * migrations dropped fails from the other side.
 */
describe('EDGE_KINDS — the edge-type registry, endpoint half', () => {
  it('names exactly the types EDGE_VERBS names', () => {
    expect(Object.keys(EDGE_KINDS).sort()).toEqual(Object.keys(EDGE_VERBS).sort());
  });

  it('every endpoint is a registry kind or the wildcard', () => {
    const known = new Set(allKinds().map((k) => k.kind));
    const offenders: string[] = [];
    for (const [type, row] of Object.entries(EDGE_KINDS)) {
      for (const kind of [...row.src, ...row.dst]) {
        if (kind !== '*' && !known.has(kind)) offenders.push(`${type} → ${kind}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it('every row carries a description, so the ledger never prints a bare id', () => {
    for (const row of Object.values(EDGE_KINDS)) expect(row.description.length).toBeGreaterThan(8);
  });

  it('relationsOf ranks a named endpoint above a wildcard admission', () => {
    const rows = relationsOf('task');
    const assigned = rows.find((r) => r.type === 'assigned_to' && r.direction === 'outgoing');
    expect(assigned).toMatchObject({ viaWildcard: false, peers: ['member', 'team_member'] });
    const related = rows.find((r) => r.type === 'relates_to' && r.direction === 'outgoing');
    expect(related?.viaWildcard).toBe(true);
    /* A task is never the TARGET of assigned_to. */
    expect(rows.find((r) => r.type === 'assigned_to' && r.direction === 'incoming')).toBeUndefined();
  });

  it('every collection kind has at least one relation (the wildcard edges see to it)', () => {
    for (const config of allKinds()) {
      if (config.kind.startsWith('c:')) continue;
      expect(relationsOf(config.kind).length, config.kind).toBeGreaterThan(0);
    }
  });
});
