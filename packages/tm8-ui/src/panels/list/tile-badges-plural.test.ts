import { describe, expect, it } from 'vitest';
import type { EntitySummary } from '@tm8/contract';
import { renderBadge } from './tile-badges';

const row = (state: Record<string, unknown>) => ({ state }) as unknown as EntitySummary;

describe('count badges agree with their count', () => {
  it('says one child, one item, one field', () => {
    expect(renderBadge('childCount', row({ childCount: 1 }))).toEqual({ slot: 'meta', text: '1 child' });
    expect(renderBadge('itemCount', row({ itemCount: 1 }))).toEqual({ slot: 'meta', text: '1 item' });
    expect(renderBadge('customFields', row({ fields: { a: 1 } }))).toEqual({ slot: 'meta', text: '1 field' });
  });

  it('keeps the plural for every other count', () => {
    expect(renderBadge('childCount', row({ childCount: 3 }))).toEqual({ slot: 'meta', text: '3 children' });
    expect(renderBadge('itemCount', row({}))).toEqual({ slot: 'meta', text: '0 items' });
    expect(renderBadge('customFields', row({ fields: { a: 1, b: 2 } }))).toEqual({ slot: 'meta', text: '2 fields' });
  });
});
