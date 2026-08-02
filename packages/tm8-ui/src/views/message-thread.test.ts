import { describe, expect, it } from 'vitest';
import type { MessageView } from '@tm8/contract';
import { representedThreadMessageCount } from './message-thread';

function row(id: string, rootMessageId: string | null, replyCount = 0): MessageView {
  return { id, replyCount, state: { rootMessageId } } as MessageView;
}

describe('representedThreadMessageCount', () => {
  it('counts roots plus their authoritative reply counts without double-counting flat replies', () => {
    expect(representedThreadMessageCount([
      row('root-1', null, 2),
      row('reply-1', 'root-1'),
      row('reply-2', 'root-1'),
    ])).toBe(3);
  });

  it('counts an orphan reply when its root is outside the bounded page', () => {
    expect(representedThreadMessageCount([row('reply-1', 'root-outside')])).toBe(1);
  });
});
