import { describe, expect, it } from 'vitest';
import type { ActivityItem, DeliverySummary, FeedItem, MessageView } from '@tm8/contract';
import {
  activityPresentation,
  canSendAgain,
  deliveryPresentation,
  deliverySummaryLine,
  directionOf,
  groupByOperation,
  safeDeliveryReason,
  viaTitle,
} from './feed-model';

/**
 * THE PURE HALF OF T10 — every derivation the surface makes from a FeedItem,
 * tested without a DOM.
 *
 * WHY THESE ARE A SEPARATE MODULE AT ALL. Each function below answers a
 * question the oracle poses in COPY ("via ×2", "1 of 2 delivered", "grouped by
 * logical-operation key op_7f2e — never by timestamps") and the honest answer
 * is derivable from `@tm8/contract` alone. Keeping them pure is what makes
 * "did we invent this?" a decidable question: if a value cannot be computed
 * from a FeedItem here, it does not get rendered there.
 *
 * ORACLE: `T10 Chat Surface Hi-Fi.dc.html`, frames "Hero — Chat surface"
 * (direction rail, via, target summary) and "Delivery and send layers"
 * (the eight badges), plus S16 (mutation group) and S20 (multi-target).
 */

const ANCHOR = 'ent-channel' as const;

function msg(over: Partial<MessageView> = {}): MessageView {
  return {
    id: 'msg-1',
    kind: 'message',
    title: '',
    spaceId: 'sp-1',
    parentId: null,
    createdAt: '2026-07-29T11:24:00.000Z',
    updatedAt: '2026-07-29T11:24:00.000Z',
    deletedAt: null,
    version: 1,
    createdBy: { id: 'act-1', displayName: 'alex', isAgent: false },
    state: {
      kind: 'message',
      anchorId: ANCHOR,
      author: { id: 'act-1', displayName: 'alex', isAgent: false },
      messageBatchId: null,
    },
    content: { kind: 'message', body: 'Focus on the guide x-offsets first.' },
    replyCount: 0,
    ...over,
  } as unknown as MessageView;
}

function messageItem(over: Partial<FeedItem> = {}, message = msg()): FeedItem {
  return {
    itemId: `feed-${message.id}`,
    createdAt: message.createdAt,
    sortId: `${message.createdAt}#${message.id}`,
    via: ['anchored'],
    actor: { id: 'act-1', displayName: 'alex', isAgent: false },
    sourceWorkSessionId: null,
    anchor: null,
    logicalOperationId: null,
    itemKind: 'message',
    message,
    delivery: [],
    ...over,
  } as FeedItem;
}

function activityItem(over: Partial<FeedItem> = {}, activity?: Partial<ActivityItem>): FeedItem {
  return {
    itemId: 'feed-act-1',
    createdAt: '2026-07-29T11:33:00.000Z',
    sortId: '2026-07-29T11:33:00.000Z#act-1',
    via: ['caused'],
    actor: { id: 'act-2', displayName: 'forge', isAgent: true },
    sourceWorkSessionId: null,
    anchor: null,
    logicalOperationId: null,
    itemKind: 'activity',
    activity: {
      id: 'act-1',
      verb: 'entity.linked',
      summary: {},
      createdAt: '2026-07-29T11:33:00.000Z',
      ...activity,
    },
    ...over,
  } as FeedItem;
}

function delivery(status: DeliverySummary['status'], target = 'ws-forge'): DeliverySummary {
  return {
    deliveryId: `dlv-${target}-${status}`,
    targetWorkSessionId: target,
    status,
    attemptNo: 1,
    failureReason: null,
    updatedAt: '2026-07-29T11:24:05.000Z',
  };
}

describe('directionOf — the oracle’s margin rail, derived from `via` and nothing else', () => {
  it('reads `anchored` as inbound and names the anchor with the caller’s noun', () => {
    // Oracle f1: via ['anchored'] renders "TO THIS SESSION". The noun is the
    // caller's because the anchor's KIND is not this component's business.
    const d = directionOf(messageItem(), ANCHOR, 'this channel');
    expect(d).toEqual({ word: 'to this channel', tone: 'inbound' });
  });

  it('reads `authored` on an item with no foreign anchor as outbound', () => {
    // Oracle f2: via ['authored','replies'] renders "FROM THIS SESSION".
    const d = directionOf(messageItem({ via: ['authored', 'replies'] }), ANCHOR, 'this channel');
    expect(d).toEqual({ word: 'from this channel', tone: 'outbound' });
  });

  it('reads an item anchored ELSEWHERE as "in <that anchor>"', () => {
    // Oracle f10: forge authored into T-114, surfaced here — "IN T-114".
    const d = directionOf(
      messageItem({
        via: ['authored'],
        anchor: { id: 'ent-task', kind: 'task', title: 'T-114' } as never,
      }),
      ANCHOR,
      'this channel',
    );
    expect(d).toEqual({ word: 'in T-114', tone: 'elsewhere' });
  });

  it('returns null rather than guessing when no predicate decides it', () => {
    // The oracle's own rail is conditional (`sc-if value="{{f.dirT}}"`), so an
    // absent direction is a DRAWN state, not a hole. Inventing a word here
    // would be the two-source-honesty failure in miniature.
    expect(directionOf(messageItem({ via: [] }), ANCHOR, 'this channel')).toBeNull();
  });
});

describe('viaTitle — the tooltip is the server’s own predicate list', () => {
  it('prints the predicates verbatim in the oracle’s sentence', () => {
    // Oracle, hero line 90: title="server-ordered via: authored · replies".
    expect(viaTitle(['authored', 'replies'])).toBe('server-ordered via: authored · replies');
  });
});

describe('deliveryPresentation — eight statuses, eight drawn states', () => {
  it('covers every MessageDeliveryStatus the contract declares', () => {
    // The count is the control: a ninth status added to the contract must fail
    // HERE rather than render as a blank badge on a real screen.
    const all = [
      'pending', 'dispatching', 'delivered', 'failed_retryable',
      'failed_permanent', 'unknown', 'expired', 'cancelled',
    ] as const;
    for (const s of all) {
      const p = deliveryPresentation(s);
      expect(p.label.length, `${s} needs a label`).toBeGreaterThan(0);
      expect(p.tooltip.length, `${s} needs a tooltip`).toBeGreaterThan(10);
    }
  });

  it('never dresses `unknown` as success — it is the warn tone, and says why', () => {
    // Oracle: "unknown — the dangerous one … Never styled as success; bytes may
    // or may not have been written." Same law as R-UI-5 liveness 'unknown'.
    const p = deliveryPresentation('unknown');
    expect(p.tone).toBe('wait');
    expect(p.tone).not.toBe('run');
    expect(p.label).toContain('unknown');
    expect(p.tooltip.toLowerCase()).toContain('may or may not');
  });

  it('scopes the delivered claim to the PTY write, never to comprehension', () => {
    // Oracle, verbatim requirement: "Tooltip must say: governed PTY write
    // completed — not that the model read or obeyed it."
    expect(deliveryPresentation('delivered').tooltip).toContain('governed PTY write completed');
    expect(deliveryPresentation('delivered').tooltip).toContain('not that the model read or obeyed');
  });

  it('keeps `pending` neutral — durable is not an alarm', () => {
    expect(deliveryPresentation('pending').tone).toBe('idle');
    expect(deliveryPresentation('pending').label).toBe('stored · waiting to send');
  });

  it('pulses ONLY while dispatching, because only progress is animated', () => {
    expect(deliveryPresentation('dispatching').pulse).toBe(true);
    expect(deliveryPresentation('delivered').pulse).toBe(false);
  });
});

describe('safe delivery failure details', () => {
  it('translates only stable reason codes and never echoes arbitrary transport text', () => {
    expect(safeDeliveryReason('restart_during_dispatch')).toBe('Node restarted during delivery');
    expect(safeDeliveryReason('postgres://user:secret@internal/messages')).toBe('Details unavailable');
    expect(safeDeliveryReason(null)).toBeNull();
  });
});

describe('typed activity presentation', () => {
  it('covers artifact, transition, terminal-state, generic event, and unknown variants', () => {
    const artifact = activityItem({
      anchor: { id: 'doc-1', kind: 'doc', title: 'Runbook' } as never,
    }, { verb: 'created' });
    expect(activityPresentation(artifact as Extract<FeedItem, { itemKind: 'activity' }>)).toMatchObject({
      kind: 'entity-change', verb: 'created', entity: { id: 'doc-1' },
    });

    const work = activityItem({}, { verb: 'work.changed', summary: { status: 'in_review' } });
    expect(activityPresentation(work as Extract<FeedItem, { itemKind: 'activity' }>)).toEqual({
      kind: 'state', label: 'Work status', from: null, to: 'in_review',
    });

    for (const [verb, to] of [
      ['completed', 'Completed'], ['deleted', 'Deleted'], ['restored', 'Restored'],
      ['joined', 'Joined'], ['pulled', 'Pulled'], ['pr.linked', 'Pull request linked'],
      ['unblocked', 'Unblocked'],
    ] as const) {
      const item = activityItem({}, { verb });
      expect(activityPresentation(item as Extract<FeedItem, { itemKind: 'activity' }>)).toEqual({
        kind: 'state', label: 'State', from: null, to,
      });
    }

    for (const verb of ['linked', 'unlinked', 'reacted', 'awarded'] as const) {
      const item = activityItem({}, { verb });
      expect(activityPresentation(item as Extract<FeedItem, { itemKind: 'activity' }>).kind).toBe('event');
    }
    const future = activityItem({}, { verb: 'future.variant' });
    expect(activityPresentation(future as Extract<FeedItem, { itemKind: 'activity' }>)).toEqual({ kind: 'unknown' });
  });
});

describe('deliverySummaryLine — the S20 chip counts, and never invents a total', () => {
  it('summarises multi-target delivery as "n of m delivered"', () => {
    const line = deliverySummaryLine([delivery('delivered', 'ws-forge'), delivery('unknown', 'ws-relay')]);
    expect(line).toBe('delivery · 1 of 2 delivered');
  });

  it('returns null with no delivery facets — no badge, not a zero badge', () => {
    // A message with no delivery rows is a message nobody attempted to deliver.
    // Drawing "0 of 0" would state a measurement that never happened.
    expect(deliverySummaryLine([])).toBeNull();
  });
});

describe('canSendAgain — retryable only, and it is a NEW message either way', () => {
  it('offers Send again on failed_retryable', () => {
    expect(canSendAgain([delivery('failed_retryable')])).toBe(true);
  });

  it('does NOT offer it on failed_permanent', () => {
    // Oracle: failed_permanent is "Error, with details where the viewer is
    // authorized" — no send-again affordance. Offering one would promise a
    // path that cannot succeed.
    expect(canSendAgain([delivery('failed_permanent')])).toBe(false);
  });

  it('does not offer it while a delivery is still in flight', () => {
    expect(canSendAgain([delivery('dispatching')])).toBe(false);
  });
});

describe('groupByOperation — S16, grouped by the operation key and NEVER by time', () => {
  it('collapses consecutive activity sharing a logicalOperationId', () => {
    const a = activityItem({ itemId: 'a', logicalOperationId: 'op_7f2e' });
    const b = activityItem({ itemId: 'b', logicalOperationId: 'op_7f2e' });
    const c = activityItem({ itemId: 'c', logicalOperationId: 'op_7f2e' });
    const groups = groupByOperation([a, b, c]);
    expect(groups).toHaveLength(1);
    expect(groups[0]).toMatchObject({ kind: 'operation', key: 'op_7f2e' });
    expect(groups[0].kind === 'operation' && groups[0].items).toHaveLength(3);
  });

  it('leaves a null key as SEPARATE honest rows, however close in time', () => {
    // Oracle S16, verbatim: "No key from the feed → separate honest rows."
    // Two rows one second apart with no key are two facts, not one operation.
    const a = activityItem({ itemId: 'a', createdAt: '2026-07-29T11:33:00.000Z' });
    const b = activityItem({ itemId: 'b', createdAt: '2026-07-29T11:33:01.000Z' });
    expect(groupByOperation([a, b])).toHaveLength(2);
  });

  it('never groups a MESSAGE into an operation, even sharing a key', () => {
    // A message is a thing someone said. Folding it into "3 records" would
    // hide human speech inside a machine summary.
    const m = messageItem({ itemId: 'm', logicalOperationId: 'op_7f2e' });
    const a = activityItem({ itemId: 'a', logicalOperationId: 'op_7f2e' });
    const groups = groupByOperation([m, a]);
    expect(groups).toHaveLength(2);
    expect(groups[0]).toMatchObject({ kind: 'single' });
  });

  it('does not collapse a lone keyed activity into a group of one', () => {
    const a = activityItem({ itemId: 'a', logicalOperationId: 'op_7f2e' });
    expect(groupByOperation([a])).toEqual([{ kind: 'single', item: a }]);
  });
});
