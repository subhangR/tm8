// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { badgeVisible, syncBadgeNodes } from './badges';
import type { PlaceBadge } from './place-asset';

const badge = (over: Partial<PlaceBadge>): PlaceBadge => ({ id: 'p1/library', placeId: 'p1', ring: 2, kind: 'library', x: 10, y: 2, z: -4, count: 3, approx: false, ...over });

describe('badge node pool', () => {
  it('creates one span per badge, reuses it on resync and drops the ones that went away', () => {
    const layer = document.createElement('div'), pool = new Map<string, HTMLSpanElement>();
    syncBadgeNodes(layer, [badge({}), badge({ id: 'p1/mailbox', kind: 'mailbox', count: 7, approx: true })], pool);
    expect(layer.querySelectorAll('.sgm-badge')).toHaveLength(2);
    const first = pool.get('p1/library')!;
    expect(first.className).toBe('sgm-badge sgm-world-label sgm-badge--library');
    expect(first.textContent).toBe('3');
    expect(pool.get('p1/mailbox')!.textContent).toBe('≈7');
    expect(first.style.display).toBe('none');
    syncBadgeNodes(layer, [badge({ count: 4 })], pool);
    expect(layer.querySelectorAll('.sgm-badge')).toHaveLength(1);
    expect(pool.get('p1/library')).toBe(first);
    expect(first.textContent).toBe('4');
    expect(first.dataset['placeId']).toBe('p1');
  });
});

describe('badge visibility', () => {
  it('follows the place labels: roots in the overview, else revealed and near', () => {
    const b = badge({ ring: 2 });
    expect(badgeVisible(b, true, new Set(), 0, 0, 14)).toBe(false);
    expect(badgeVisible(badge({ ring: 1 }), true, new Set(), 0, 0, 14)).toBe(true);
    expect(badgeVisible(b, false, new Set(), 10, -4, 14)).toBe(false);
    expect(badgeVisible(b, false, new Set(['p1']), 10, -4, 14)).toBe(true);
    expect(badgeVisible(b, false, new Set(['p1']), 30, -4, 14)).toBe(false);
  });
});
