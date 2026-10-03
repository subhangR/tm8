import { expect, it } from 'vitest';
import { boundEntityDetail } from '../src/entity-bounded.js';
import { byteLength, CAPS, nounHelp, rootHelp } from '../src/discovery/help.js';

it('discovers a bounded story guide with real universal command forms', () => {
  expect(rootHelp().nouns.some(n => n.name === 'story')).toBe(true);
  const help = nounHelp('story')!;
  expect(help).toBeDefined();
  expect(byteLength(help)).toBeLessThanOrEqual(CAPS.noun);
  const text = JSON.stringify(help.guide);
  for (const command of ['entity create story', 'collection add', 'entity context', 'entity update', 'entity query', 'graph query']) expect(text).toContain(command);
  expect(text).toContain('Story status is set by hand');
  expect(text).toContain('omitted[]');
  expect(text).toContain('--story-page');
  expect(text).toContain('session spawn --story');
  for (const definition of ['progress counts', 'taskProgress counts', 'rollup is the union', 'deduplicated by entity ID', 'off-by-one', 'staleInProgress is a subset', 'absent means unavailable', 'STORY-PROGRESS.md']) expect(text).toContain(definition);
});

it('points bounded story detail readers to the explicit browser-page escape', () => {
  const detail = boundEntityDetail({ id: 'story-id', kind: 'story', content: { kind: 'story', description: '', page: null } });
  expect(detail.next).toMatchObject({ page: 'tm8 entity get story-id --story-page --full --format json' });
});
