import { describe, expect, it } from 'vitest';
import { build, defaultRoute, parse } from './codec';
import { NODE_ADMIN_ROUTE_SECTIONS, SETTINGS_ROUTE_SECTIONS } from './types';

const spaceId = '019f98a0-1111-2222-3333-444455556666';

describe('admin page addresses', () => {
  for (const section of [null, ...SETTINGS_ROUTE_SECTIONS]) {
    it(`preserves Space admin section ${section ?? 'default'}`, () => {
      const target = { view: 'settings', scope: 'space', section } as const;
      const { hash } = build(defaultRoute(spaceId, target));
      expect(hash).toBe(`#/s/${spaceId}/space-admin${section ? `/${section}` : ''}`);
      expect(parse(hash).route?.target).toEqual(target);
    });
  }
  for (const section of [null, ...NODE_ADMIN_ROUTE_SECTIONS]) {
    it(`preserves Node admin section ${section ?? 'default'}`, () => {
      const target = { view: 'settings', scope: 'node', section } as const;
      const { hash } = build(defaultRoute(spaceId, target));
      expect(hash).toBe(`#/s/${spaceId}/node-admin${section ? `/${section}` : ''}`);
      expect(parse(hash).route?.target).toEqual(target);
    });
  }
  it('keeps unknown node sections on the guarded node page', () => {
    expect(parse(`#/s/${spaceId}/node-admin/members`).route?.target)
      .toEqual({ view: 'settings', scope: 'node', section: null });
  });
  it.each([['node-credentials', 'credentials'], ['filesystem-access', 'filesystem']])(
    'moves old %s links through the node access guard', (legacy, section) => {
      expect(parse(`#/s/${spaceId}/settings/${legacy}`).route?.target)
        .toEqual({ view: 'settings', scope: 'node', section });
    },
  );
  it('preserves existing shared space credential links for ordinary members', () => {
    expect(parse(`#/s/${spaceId}/settings/space-credentials`).route?.target)
      .toEqual({ view: 'settings', section: 'space-credentials' });
  });
});
