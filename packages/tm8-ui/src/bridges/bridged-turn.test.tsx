// @vitest-environment jsdom
import { fireEvent, render, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { ActorSummary, BridgeDelivery, EntityId, MessageBridgeView } from '@tm8/contract';
import { ChatTurn } from '../chat-home/ChatTurn';
import type { ChatTurn as ChatTurnModel } from '../chat-home/types';
import { chatTurnFromMessage } from '../channel-screen/feed-to-turns';
import { BridgedFromChip, BridgeDeliveryTick, bridgeDeliveryWords } from './bridge-marks';

const BRIDGE = '019f0000-0000-7000-8000-0000000000b1' as EntityId;
const AT = '2026-10-30T10:42:00.000Z';

const BRIDGE_AUTHOR: ActorSummary = {
  id: BRIDGE, kind: 'bridge' as ActorSummary['kind'], displayName: 'Infra · WhatsApp', avatar: null, isAgent: false,
};
const SUBHANG: ActorSummary = {
  id: '019f0000-0000-7000-8000-0000000000a1', kind: 'member', displayName: 'Subhang', avatar: null, isAgent: false,
};
const AGENT: ActorSummary = {
  id: '019f0000-0000-7000-8000-0000000000c1', kind: 'team_member', displayName: 'Opus', avatar: null, isAgent: true,
};

function inbound(trust: MessageBridgeView['trust'], participant: string | null = 'Rahul Mehta'): MessageBridgeView {
  return { bridgeId: BRIDGE, provider: 'whatsapp', conversation: 'Infra', direction: 'in', participant, trust, delivery: null };
}
function delivery(over: Partial<BridgeDelivery>): BridgeDelivery {
  return { messageId: 'm', bridgeId: BRIDGE, status: 'sent', at: AT, ...over };
}
function outbound(d: BridgeDelivery | null): MessageBridgeView {
  return { bridgeId: BRIDGE, provider: 'whatsapp', conversation: 'Infra', direction: 'out', participant: null, trust: null, delivery: d };
}
function turn(author: ActorSummary, bridge: MessageBridgeView | undefined, role: 'user' | 'assistant' = 'user'): ChatTurnModel {
  return {
    messageId: '019f0000-0000-7000-8000-0000000000d1' as EntityId,
    role, author, createdAt: AT, body: 'is the deploy done?', parts: [],
    ...(bridge ? { bridge } : {}),
  };
}

describe('a bridged inbound bubble (§4.5, D4)', () => {
  it('a guest is shown by the participant name, not the bridge, on idle-tone initials', () => {
    const view = render(<ChatTurn turn={turn(BRIDGE_AUTHOR, inbound('guest'))} viewerId={SUBHANG.id} />);
    const byline = view.container.querySelector('.tch-turn__byline')!;
    expect(within(byline as HTMLElement).getByText('Rahul Mehta', { selector: 'strong' })).toBeTruthy();
    expect(byline.textContent).not.toContain('Infra · WhatsApp');
    const avatar = view.getByTestId('bridge-avatar').querySelector('.kit-avatar')!;
    expect(avatar.classList.contains('bridge-avatar--guest')).toBe(true);
    expect(avatar.textContent).toBe('RM');
    // No provider mark on a guest's avatar; the via line carries it.
    expect(view.getByTestId('bridge-avatar').querySelector('.bridge-mark')).toBeNull();
    const via = view.getByTestId('bridge-via');
    expect(via.textContent).toContain('via WhatsApp');
    expect(via.querySelector('[data-trust="guest"]')?.textContent).toBe('guest');
    expect(view.container.querySelector('.tch-turn')?.getAttribute('data-self')).toBe('false');
  });

  it('two guests never share one colour identity', () => {
    const a = render(<ChatTurn turn={turn(BRIDGE_AUTHOR, inbound('guest', 'Rahul'))} />);
    const b = render(<ChatTurn turn={turn(BRIDGE_AUTHOR, inbound('guest', 'Asha'))} />);
    const idOf = (v: typeof a) => v.container.querySelector('.kit-avatar')!.getAttribute('data-actor-id');
    expect(idOf(a)).not.toBe(idOf(b));
    expect(idOf(a)).not.toBe(BRIDGE);
  });

  it('a linked member keeps their own name and avatar, with the provider mark overlaid', () => {
    const view = render(<ChatTurn turn={turn(SUBHANG, inbound('linked', 'Subhang (phone)'))} />);
    expect(view.getByText('Subhang', { selector: 'strong' })).toBeTruthy();
    const avatar = view.getByTestId('bridge-avatar');
    expect(avatar.querySelector('.kit-avatar')?.getAttribute('data-actor-id')).toBe(SUBHANG.id);
    expect(avatar.querySelector('.bridge-mark')?.getAttribute('data-provider')).toBe('whatsapp');
    expect(view.getByTestId('bridge-via').querySelector('[data-trust="linked"]')?.textContent).toBe('linked ✓');
  });

  it('an asserted link says so', () => {
    const view = render(<ChatTurn turn={turn(SUBHANG, inbound('asserted'))} />);
    expect(view.getByTestId('bridge-via').querySelector('[data-trust="asserted"]')?.textContent).toBe('asserted');
  });

  it('the via mark opens the bridge', () => {
    const onOpen = vi.fn();
    const view = render(<ChatTurn turn={turn(BRIDGE_AUTHOR, inbound('guest'))} onOpenEntity={onOpen} />);
    fireEvent.click(view.getByRole('button', { name: 'Open the bridge: WhatsApp · Infra' }));
    expect(onOpen).toHaveBeenCalledWith(BRIDGE);
  });

  it('an inbound bubble carries no delivery tick', () => {
    const view = render(<ChatTurn turn={turn(BRIDGE_AUTHOR, inbound('guest'))} />);
    expect(view.queryByTestId('bridge-tick')).toBeNull();
  });
});

describe('the delivery tick under an outbound message (§2.3, D64)', () => {
  it('an agent turn answer shows the tick under it', () => {
    const view = render(<ChatTurn turn={turn(AGENT, outbound(delivery({ status: 'sent' })), 'assistant')} />);
    const tick = view.getByTestId('bridge-tick');
    expect(tick.getAttribute('data-status')).toBe('sent');
    expect(tick.textContent).toContain('sent to WhatsApp');
    expect(tick.querySelector('time')?.getAttribute('dateTime')).toBe(AT);
    expect(view.queryByTestId('bridge-via')).toBeNull();
  });

  it('a message that does not cross shows no tick', () => {
    const view = render(<ChatTurn turn={turn(AGENT, outbound(null), 'assistant')} />);
    expect(view.queryByTestId('bridge-tick')).toBeNull();
  });

  it.each([
    [{ status: 'pending' as const }, 'wait', 'queued', false],
    [{ status: 'sent' as const }, 'run', 'sent to WhatsApp', true],
    [{ status: 'failed_retryable' as const, detail: 'connection closed' }, 'wait', 'retrying', false],
    [{ status: 'failed_permanent' as const, detail: 'too long' }, 'block', 'failed: too long', true],
    [{ status: 'refused' as const, reason: 'bridge_paused' as const }, 'idle', 'not sent: bridge paused', false],
    [{ status: 'refused' as const, reason: 'worker_posting_off' as const }, 'idle', 'not sent: worker posting is off', false],
    [{ status: 'refused' as const, reason: 'rate_limited' as const, retryAfterMs: 42_000 }, 'wait', 'not sent: rate limited · retry in 42s', false],
  ])('%o reads as %s "%s"', (over, tone, label, timed) => {
    const words = bridgeDeliveryWords(delivery(over), 'whatsapp');
    expect(words.tone).toBe(tone);
    expect(words.label).toBe(label);
    const view = render(<BridgeDeliveryTick delivery={delivery(over)} provider="whatsapp" />);
    const tick = view.getByTestId('bridge-tick');
    expect(tick.getAttribute('data-tone')).toBe(tone);
    // Colour AND word: the word is always in the DOM.
    expect(tick.querySelector('.bridge-tick__word')?.textContent).toBe(label);
    expect(tick.querySelector('time') !== null).toBe(timed);
  });

  it('never claims delivered or read: the ledger has no receipts (D64)', () => {
    for (const status of ['pending', 'sent', 'failed_retryable', 'failed_permanent', 'refused'] as const) {
      const w = bridgeDeliveryWords(delivery({ status }), 'whatsapp');
      expect(`${w.label} ${w.title}`).not.toMatch(/\b(delivered|read)\b/i);
    }
  });
});

describe('the feed carries the bridge onto the turn', () => {
  it('chatTurnFromMessage keeps MessageView.bridge', () => {
    const bridge = inbound('guest');
    const t = chatTurnFromMessage({
      id: '019f0000-0000-7000-8000-0000000000d2', kind: 'message', createdAt: AT,
      state: { kind: 'message', anchorId: BRIDGE, author: BRIDGE_AUTHOR },
      content: { kind: 'message', body: 'hi', mentions: [], attachments: [] },
      replyCount: 0, bridge,
    } as unknown as Parameters<typeof chatTurnFromMessage>[0]);
    expect(t.bridge).toEqual(bridge);
  });
});

describe('the header chip (§4.5)', () => {
  it('says Bridged from WhatsApp · Infra and opens the bridge', () => {
    const onOpen = vi.fn();
    const view = render(<BridgedFromChip bridged={{ bridgeId: BRIDGE, provider: 'whatsapp', conversation: 'Infra', status: 'live' }} onOpen={onOpen} />);
    const chip = view.getByTestId('bridged-from');
    expect(chip.textContent).toBe('◍Bridged from WhatsApp · Infra');
    fireEvent.click(chip);
    expect(onOpen).toHaveBeenCalledWith(BRIDGE);
  });

  it('a paused bridge says so in words', () => {
    const view = render(<BridgedFromChip bridged={{ bridgeId: BRIDGE, provider: 'whatsapp', conversation: 'Infra', status: 'paused' }} />);
    expect(view.getByTestId('bridged-from').querySelector('[data-status="paused"]')?.textContent).toBe('paused');
  });
});
