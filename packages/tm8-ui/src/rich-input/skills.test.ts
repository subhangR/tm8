/**
 * The `/` trigger's subject (`skills.ts`): options come from one kind-filtered
 * seam query and the committed reference is the durable form — label for the
 * human, entity id for the rename, both riding the body because the body is
 * the one channel agents actually receive.
 */
import { describe, expect, it, vi } from 'vitest';
import type { CollectionResult } from '@tm8/contract';
import { loadSkillTriggerOptions, skillReference } from './skills';

const SPACE = '0192aaaa-0000-7000-8000-000000000001';

function skillRow(id: string, title: string, description?: string) {
  return {
    id,
    title,
    state: { kind: 'skill', equipped: false, ...(description ? { description } : {}) },
  };
}

describe('loadSkillTriggerOptions', () => {
  it('queries the skill kind and maps title/description into options, alphabetical', async () => {
    const query = vi.fn().mockResolvedValue({
      page: {
        items: [
          skillRow('s2', 'ship checklist'),
          skillRow('s1', 'code review', 'How this team reviews'),
        ],
      },
    } as unknown as CollectionResult);

    const options = await loadSkillTriggerOptions({ port: { query }, spaceId: SPACE as never });

    expect(query).toHaveBeenCalledWith(expect.objectContaining({ spaceId: SPACE, kinds: ['skill'] }));
    expect(options).toEqual([
      { id: 's1', display: 'code review', meta: 'How this team reviews' },
      { id: 's2', display: 'ship checklist' },
    ]);
  });
});

describe('skillReference', () => {
  it('is a markdown link: /name label, tm8://skill/<id> target, trailing separator', () => {
    expect(skillReference('code review', 'abc-123')).toBe('[/code review](tm8://skill/abc-123) ');
  });

  it('escapes markdown label closers so the link survives odd names', () => {
    expect(skillReference('a]b', 'id1')).toBe('[/a\\]b](tm8://skill/id1) ');
  });

  it('never emits an empty label', () => {
    expect(skillReference('   ', 'id1')).toBe('[/skill](tm8://skill/id1) ');
  });
});
