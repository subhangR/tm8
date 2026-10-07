import { describe, expect, it } from 'vitest';
import { EDGE_FAMILIES, edgeFamily } from './edge-families';
import { EDGE_VERBS } from './edge-verbs';

describe('edge families', () => {
  it('gives every verb row a family, and has no row for a type with no verb', () => {
    expect(Object.keys(EDGE_FAMILIES).sort()).toEqual(Object.keys(EDGE_VERBS).sort());
  });

  it('reads a direction-dependent type from the open entity’s side', () => {
    expect(edgeFamily('working_on', 'outgoing')).toBe('work');
    expect(edgeFamily('working_on', 'incoming')).toBe('sessions');
    expect(edgeFamily('participates_in', 'incoming')).toBe('people');
  });

  it('puts an unknown type under work rather than hiding it', () => {
    expect(edgeFamily('from_a_newer_server', 'outgoing')).toBe('work');
  });
});
