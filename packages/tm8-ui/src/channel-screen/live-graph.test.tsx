// @vitest-environment jsdom
/**
 * LIVE GRAPH — the pure fold, the message-bounded turn segmentation, and the
 * in-feed TurnGraph row that stands where Session Chat's raw activity would
 * otherwise render.
 *
 * The graph is derived from the SAME `page.items` the feed draws, so the
 * tests feed it feed items, never a server: no seam, no reads, by design.
 */
import { describe, expect, it } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import type { ActivityItem, EntityFeedPage, EntityId, FeedItem } from '@tm8/contract';
import { edgeLabel, foldLiveGraph, segmentTurnGraphs } from './live-graph-model';
import { TurnGraph } from './LiveToolGraph';
import { ChannelScreen } from './ChannelScreen';

const SESSION = 'ws-1' as EntityId;

function activityItem(
  over: Partial<FeedItem> = {},
  activity?: Partial<ActivityItem>,
): FeedItem {
  return {
    itemId: over.itemId ?? 'feed-act-1',
    createdAt: '2026-07-29T11:33:00.000Z',
    sortId: '2026-07-29T11:33:00.000Z#act-1',
    via: ['caused'],
    actor: { id: 'act-2', displayName: 'forge', isAgent: true },
    sourceWorkSessionId: SESSION,
    anchor: null,
    logicalOperationId: null,
    itemKind: 'activity',
    activity: {
      id: 'act-1',
      verb: 'updated',
      summary: {},
      createdAt: '2026-07-29T11:33:00.000Z',
      ...activity,
    },
    ...over,
  } as FeedItem;
}

function messageItem(id = 'msg-1', at = '2026-07-29T11:30:00.000Z', body = `Body of ${id}`): FeedItem {
  return {
    itemId: `feed-${id}`,
    createdAt: at,
    sortId: `${at}#${id}`,
    via: ['anchored'],
    actor: { id: 'act-1', displayName: 'alex', isAgent: false },
    sourceWorkSessionId: null,
    anchor: null,
    logicalOperationId: null,
    itemKind: 'message',
    message: {
      id,
      kind: 'message',
      title: '',
      spaceId: 'sp-1',
      parentId: null,
      createdAt: at,
      updatedAt: at,
      deletedAt: null,
      version: 1,
      createdBy: { id: 'act-1', displayName: 'alex', isAgent: false },
      state: {
        kind: 'message',
        anchorId: SESSION,
        author: { id: 'act-1', displayName: 'alex', isAgent: false },
        messageBatchId: null,
      },
      content: { kind: 'message', body, mentions: [], attachments: [] },
      replyCount: 0,
    },
    delivery: [],
  } as unknown as FeedItem;
}

function feedPage(items: FeedItem[]): EntityFeedPage {
  return {
    resolvedScope: 'session_chat_v1',
    predicates: ['anchored'],
    items,
    nextCursor: null,
  } as unknown as EntityFeedPage;
}

const touch = (
  itemId: string,
  entityId: string,
  verb: string,
  at: string,
  title = `Entity ${entityId}`,
  kind = 'task',
): FeedItem =>
  activityItem(
    { itemId, createdAt: at, anchor: { id: entityId, kind, title } as never },
    { verb },
  );

describe('foldLiveGraph', () => {
  it('one node per distinct entity; repeat touches accumulate verbs, never nodes', () => {
    const model = foldLiveGraph([
      touch('a1', 'task-1', 'updated', '2026-07-29T10:00:00.000Z'),
      touch('a2', 'task-1', 'updated', '2026-07-29T10:01:00.000Z'),
      touch('a3', 'doc-1', 'created', '2026-07-29T10:02:00.000Z', 'Runbook', 'doc'),
    ], SESSION);
    expect(model.touches).toHaveLength(2);
    expect(model.activityCount).toBe(3);
    const task = model.touches[0]!;
    expect(task.id).toBe('task-1');
    expect(task.verbs).toEqual({ updated: 2 });
    expect(task.count).toBe(2);
    expect(edgeLabel(task)).toBe('updated ×2');
    expect(edgeLabel(model.touches[1]!)).toBe('created');
  });

  it('placement order is FIRST touch, so settled nodes never move when new ones arrive', () => {
    const early = foldLiveGraph([
      touch('a1', 'doc-1', 'created', '2026-07-29T10:00:00.000Z'),
    ], SESSION);
    const later = foldLiveGraph([
      touch('a1', 'doc-1', 'created', '2026-07-29T10:00:00.000Z'),
      touch('a2', 'task-1', 'updated', '2026-07-29T10:05:00.000Z'),
      touch('a3', 'doc-1', 'updated', '2026-07-29T10:06:00.000Z'),
    ], SESSION);
    expect(early.touches[0]!.id).toBe('doc-1');
    expect(later.touches.map((t) => t.id)).toEqual(['doc-1', 'task-1']);
  });

  it('ignores messages, anchor-less activity, and the session touching itself', () => {
    const model = foldLiveGraph([
      messageItem(),
      activityItem({ anchor: null }, { verb: 'joined' }),
      touch('a1', SESSION, 'updated', '2026-07-29T10:00:00.000Z', 'self', 'work_session'),
    ], SESSION);
    expect(model.touches).toHaveLength(0);
    expect(model.activityCount).toBe(0);
  });

  it('the freshest summary wins the label, so a rename shows up live', () => {
    const model = foldLiveGraph([
      touch('a1', 'task-1', 'created', '2026-07-29T10:00:00.000Z', 'Old title'),
      touch('a2', 'task-1', 'updated', '2026-07-29T10:05:00.000Z', 'New title'),
    ], SESSION);
    expect(model.touches[0]!.title).toBe('New title');
  });
});

describe('segmentTurnGraphs', () => {
  it('one turn per maximal consecutive activity run, bounded by messages — never timestamps', () => {
    const segments = segmentTurnGraphs([
      messageItem('m1', '2026-07-29T10:00:00.000Z'),
      touch('a1', 'task-1', 'updated', '2026-07-29T10:01:00.000Z'),
      touch('a2', 'doc-1', 'created', '2026-07-29T10:02:00.000Z', 'Runbook', 'doc'),
      messageItem('m2', '2026-07-29T10:03:00.000Z'),
      touch('a3', 'task-1', 'updated', '2026-07-29T10:04:00.000Z'),
    ], SESSION);
    expect(segments.map((s) => s.kind)).toEqual(['item', 'turn', 'item', 'turn']);
    const first = segments[1]!;
    if (first.kind !== 'turn') throw new Error('expected turn');
    expect(first.firstId).toBe('a1');
    expect(first.model.touches.map((t) => t.id)).toEqual(['task-1', 'doc-1']);
  });

  it('a trailing run and a leading run each fold as their own turn', () => {
    const segments = segmentTurnGraphs([
      touch('a1', 'task-1', 'updated', '2026-07-29T10:00:00.000Z'),
      messageItem('m1', '2026-07-29T10:01:00.000Z'),
      touch('a2', 'doc-1', 'created', '2026-07-29T10:02:00.000Z', 'Runbook', 'doc'),
    ], SESSION);
    expect(segments.map((s) => s.kind)).toEqual(['turn', 'item', 'turn']);
  });

  it('an anchorless run is emitted as an EMPTY turn — a boundary, never a graph', () => {
    const segments = segmentTurnGraphs([
      messageItem('m1', '2026-07-29T10:00:00.000Z'),
      activityItem({ itemId: 'a1', anchor: null }, { verb: 'joined' }),
      messageItem('m2', '2026-07-29T10:02:00.000Z'),
    ], SESSION);
    expect(segments.map((s) => s.kind)).toEqual(['item', 'turn', 'item']);
    const run = segments[1]!;
    if (run.kind !== 'turn') throw new Error('expected turn');
    expect(run.model.touches).toHaveLength(0);
  });
});

describe('TurnGraph row', () => {
  it('renders nothing at all for an empty fold', () => {
    render(
      <ul>
        <TurnGraph model={foldLiveGraph([messageItem()], SESSION)} anchorNoun="this session" />
      </ul>,
    );
    expect(screen.queryByTestId('chs-turn-graph')).toBeNull();
    cleanup();
  });

  it('draws one aggregated node per entity in NEUTRAL count language — no verbs, no tool names', () => {
    render(
      <ul>
        <TurnGraph
          model={foldLiveGraph([
            touch('a1', 'task-1', 'chat.tool_called', '2026-07-29T10:00:00.000Z', 'Fix login'),
            touch('a2', 'task-1', 'updated', '2026-07-29T10:01:00.000Z', 'Fix login'),
          ], SESSION)}
          anchorNoun="this session"
        />
      </ul>,
    );
    expect(screen.getByTestId('chs-turn-graph').textContent).toContain('1 entity');
    expect(screen.getByRole('img', { name: /turn graph: this session touched 1 entity/i })).toBeTruthy();
    expect(screen.getByLabelText(/task: fix login — 2 touches/i)).toBeTruthy();
    // The verb strings never reach the DOM — tool-shaped verbs stay out of chat.
    expect(screen.getByTestId('chs-turn-graph').textContent).not.toContain('chat.tool_called');
    expect(screen.getByTestId('chs-turn-graph').textContent).not.toContain('updated');
    cleanup();
  });

  it('a node opens its entity through the wired handler, by click and by keyboard', () => {
    const opened: string[] = [];
    render(
      <ul>
        <TurnGraph
          model={foldLiveGraph(
            [touch('a1', 'task-1', 'updated', '2026-07-29T10:00:00.000Z', 'Fix login')],
            SESSION,
          )}
          anchorNoun="this session"
          onOpenEntity={(id) => opened.push(id)}
        />
      </ul>,
    );
    const node = screen.getByRole('button', { name: /task: fix login/i });
    fireEvent.click(node);
    fireEvent.keyDown(node, { key: 'Enter' });
    expect(opened).toEqual(['task-1', 'task-1']);
    cleanup();
  });
});

describe('Session Chat per-turn presentation (ChannelScreen turnGraphs)', () => {
  const base = { anchorId: SESSION, anchorNoun: 'this session', turnGraphs: true };

  it('message/activity/activity/message ⇒ 2 messages, exactly 1 graph, zero activity rows', () => {
    render(
      <ChannelScreen
        {...base}
        page={feedPage([
          messageItem('m1', '2026-07-29T10:00:00.000Z'),
          touch('a1', 'task-1', 'updated', '2026-07-29T10:01:00.000Z', 'Fix login'),
          touch('a2', 'task-1', 'updated', '2026-07-29T10:02:00.000Z', 'Fix login'),
          messageItem('m2', '2026-07-29T10:03:00.000Z'),
        ])}
      />,
    );
    expect(screen.getByText('Body of m1')).toBeTruthy();
    expect(screen.getByText('Body of m2')).toBeTruthy();
    expect(screen.getAllByTestId('chs-turn-graph')).toHaveLength(1);
    // The duplicate touches aggregate onto ONE node with its count.
    expect(screen.getByLabelText(/task: fix login — 2 touches/i)).toBeTruthy();
    // No raw activity or tool rows in any of their drawn forms.
    expect(screen.queryByTestId('chs-artifact')).toBeNull();
    expect(screen.queryByTestId('chs-state')).toBeNull();
    expect(screen.queryByTestId('chs-event')).toBeNull();
    expect(screen.queryByTestId('chs-unknown')).toBeNull();
    // And the old session-wide collapsible strip is gone.
    expect(screen.queryByTestId('chs-livegraph')).toBeNull();
    cleanup();
  });

  it('two activity runs separated by a message ⇒ two turn graphs', () => {
    render(
      <ChannelScreen
        {...base}
        page={feedPage([
          messageItem('m1', '2026-07-29T10:00:00.000Z'),
          touch('a1', 'task-1', 'updated', '2026-07-29T10:01:00.000Z'),
          messageItem('m2', '2026-07-29T10:02:00.000Z'),
          touch('a2', 'doc-1', 'created', '2026-07-29T10:03:00.000Z', 'Runbook', 'doc'),
        ])}
      />,
    );
    expect(screen.getAllByTestId('chs-turn-graph')).toHaveLength(2);
    cleanup();
  });

  it('an anchorless-only run renders nothing — no row, no empty graph', () => {
    render(
      <ChannelScreen
        {...base}
        page={feedPage([
          messageItem('m1', '2026-07-29T10:00:00.000Z'),
          activityItem({ itemId: 'a1', anchor: null }, { verb: 'joined' }),
          messageItem('m2', '2026-07-29T10:02:00.000Z'),
        ])}
      />,
    );
    expect(screen.queryByTestId('chs-turn-graph')).toBeNull();
    expect(screen.queryByTestId('chs-state')).toBeNull();
    expect(screen.queryByTestId('chs-event')).toBeNull();
    cleanup();
  });

  it('Channel Chat keeps its raw activity rows — the mode is strictly opt-in', () => {
    render(
      <ChannelScreen
        anchorId={'ent-channel' as EntityId}
        anchorNoun="this channel"
        page={feedPage([
          messageItem('m1', '2026-07-29T10:00:00.000Z'),
          touch('a1', 'task-1', 'updated', '2026-07-29T10:01:00.000Z', 'Fix login'),
        ])}
      />,
    );
    expect(screen.queryByTestId('chs-turn-graph')).toBeNull();
    expect(screen.getByTestId('chs-artifact')).toBeTruthy();
    cleanup();
  });

  it('a live page update grows the CORRECT turn graph in place', () => {
    const before = [
      messageItem('m1', '2026-07-29T10:00:00.000Z'),
      touch('a1', 'task-1', 'updated', '2026-07-29T10:01:00.000Z', 'Fix login'),
    ];
    const { rerender } = render(<ChannelScreen {...base} page={feedPage(before)} />);
    expect(screen.getAllByTestId('chs-turn-graph')).toHaveLength(1);
    expect(screen.getByLabelText(/task: fix login — 1 touch$/i)).toBeTruthy();
    rerender(
      <ChannelScreen
        {...base}
        page={feedPage([
          ...before,
          touch('a2', 'task-1', 'updated', '2026-07-29T10:02:00.000Z', 'Fix login'),
          touch('a3', 'doc-1', 'created', '2026-07-29T10:03:00.000Z', 'Runbook', 'doc'),
        ])}
      />,
    );
    expect(screen.getAllByTestId('chs-turn-graph')).toHaveLength(1);
    expect(screen.getByLabelText(/task: fix login — 2 touches/i)).toBeTruthy();
    expect(screen.getByLabelText(/doc: runbook — 1 touch/i)).toBeTruthy();
    cleanup();
  });
});
