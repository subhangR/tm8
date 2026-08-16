/**
 * The pinned blueprint node shape, and the door/mirror asymmetry that keeps a
 * stored row readable forever.
 */
import { describe, expect, it } from 'vitest';
import {
  EntityContentSchema,
  GraphContentInputSchema,
  GraphNodeInputSchema,
  GraphNodeSchema,
} from '../src/schemas';

const UUID = '019fbf18-b652-7177-a464-cf2cbaa31ed4';
const row = (node: Record<string, unknown>) => ({
  kind: 'graph' as const, graphType: 'entity',
  nodes: [node], edges: [], layout: {}, source: null,
});

describe('the write door refuses a `ref` that is not an entity id', () => {
  it('accepts a well-formed ref', () => {
    expect(GraphNodeInputSchema.safeParse({ id: 't-schema', ref: UUID }).success).toBe(true);
  });

  it('refuses a row-local slug in `ref`, and says what to do instead', () => {
    const parsed = GraphNodeInputSchema.safeParse({ id: 't-schema', ref: 't-schema' });
    expect(parsed.success).toBe(false);
    expect(JSON.stringify(parsed.error?.issues)).toContain('use `id` for the row-local key');
  });

  it('holds the legacy alias to the same standard', () => {
    expect(GraphNodeInputSchema.safeParse({ id: 'a', entityId: 'not-a-uuid' }).success).toBe(false);
  });

  it('never refuses a spec — a slug `id` beside a spec is the pinned shape', () => {
    expect(GraphNodeInputSchema.safeParse({
      id: 't-schema', spec: { kind: 'task', title: 'Pin it', hint: 'writers guess' },
    }).success).toBe(true);
    expect(GraphContentInputSchema.safeParse(row({ id: 't-schema', spec: { kind: 'task' } })).success).toBe(true);
  });
});

describe('the READ arm never refuses what is already stored', () => {
  /* Unreadable is strictly worse than untidy: EntityContentSchema is ONE union
     over the whole entity, so a rejected node fails the entire entity read. */
  it.each(['legacy-slug-ref', 'not-a-uuid', 'anything at all'])(
    'reads a row back whose stored ref is %j, though the door would refuse it',
    (ref) => {
      expect(GraphNodeSchema.safeParse({ id: 'a', ref }).success).toBe(true);
      expect(EntityContentSchema.safeParse(row({ id: 'a', ref })).success).toBe(true);
      /* …and the door still refuses it, which is the asymmetry. */
      expect(GraphContentInputSchema.safeParse(row({ id: 'a', ref })).success).toBe(false);
    },
  );

  it('reads back the real row shape: slug id + spec, and mirrored uuid refs', () => {
    expect(EntityContentSchema.safeParse(row({ id: 't-guard', spec: { kind: 'task', title: 'x' } })).success).toBe(true);
    expect(EntityContentSchema.safeParse(row({ id: UUID, ref: UUID, entityId: UUID })).success).toBe(true);
  });
});
