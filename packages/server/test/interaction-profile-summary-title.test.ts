import { describe, expect, it } from 'vitest';
import {
  ENTITY_COLUMNS,
  ENTITY_FROM,
  titleOf,
  type EntityRow,
} from '../src/facade/entity-read.js';
import { PgEntityProjector } from '../src/events/projector.js';
import type { Querier } from '../src/db/types.js';

describe('Interaction Profile summary titles', () => {
  it('projects the authored profile name into collection summaries', () => {
    expect(ENTITY_COLUMNS).toContain("profile_version.draft_json ->> 'name' as ip_name");
    expect(ENTITY_FROM).toContain('interaction_profile_versions profile_version');

    const row = {
      kind: 'interaction_profile',
      deleted_at: null,
      ip_name: 'Focused Chat — text only',
    } as EntityRow;

    expect(titleOf(row)).toBe('Focused Chat — text only');
  });

  it('keeps the legacy empty title when no versioned name exists', () => {
    const row = {
      kind: 'interaction_profile',
      deleted_at: null,
      ip_name: null,
    } as EntityRow;

    expect(titleOf(row)).toBe('');
  });

  it('keeps the authored name on live entity events', async () => {
    const id = '00000000-0000-7000-8000-000000000041';
    const row = {
      id,
      space_id: '00000000-0000-7000-8000-000000000042',
      kind: 'interaction_profile',
      parent_id: null,
      position: 1,
      visibility: 'space',
      version: 3,
      activity_at: '2026-07-30T00:00:00.000Z',
      created_at: '2026-07-30T00:00:00.000Z',
      updated_at: '2026-07-30T00:00:00.000Z',
      deleted_at: null,
      created_by: id,
      ip_name: 'Core Chat — full collaboration',
      ip_status: 'active',
      ip_current_draft_version: 1,
      ip_active_version: 1,
      ip_active_hash: 'sha256:profile',
      ip_retired_at: null,
    };
    const q = {
      query: async (sql: string) => sql.includes('from public.entities e') ? [row] : [],
    } as unknown as Querier;

    const summaries = await new PgEntityProjector().entitySummaries(q, [id]);
    expect(summaries.get(id)?.title).toBe('Core Chat — full collaboration');
  });
});
