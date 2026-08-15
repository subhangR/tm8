// @vitest-environment jsdom
/**
 * LIVE TOOL GRAPH — the pure fold and the collapsible strip.
 *
 * The graph is derived from the SAME `page.items` the chip rows draw, so the
 * tests feed it feed items, never a server: no seam, no reads, by design.
 */
import { describe, expect, it } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import type { ActivityItem, EntityId, FeedItem } from '@tm8/contract';
import { edgeLabel, foldLiveGraph } from './live-graph-model';
import { LiveToolGraph } from './LiveToolGraph';

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

function messageItem(): FeedItem {
  return {
    itemId: 'feed-msg-1',
    createdAt: '2026-07-29T11:30:00.000Z',
    sortId: '2026-07-29T11:30:00.000Z#msg-1',
    via: ['authored'],
    actor: null,
    sourceWorkSessionId: null,
    anchor: null,
    logicalOperationId: null,
    itemKind: 'message',
    message: { id: 'msg-1' },
    delivery: [],
  } as unknown as FeedItem;
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

describe('LiveToolGraph strip', () => {
  it('renders nothing at all when no activity touched an entity', () => {
    render(<LiveToolGraph items={[messageItem()]} anchorId={SESSION} anchorNoun="this session" />);
    expect(screen.queryByTestId('chs-livegraph')).toBeNull();
    cleanup();
  });

  it('collapsed by default with honest counts; expanding draws the star', () => {
    render(
      <LiveToolGraph
        items={[
          touch('a1', 'task-1', 'updated', '2026-07-29T10:00:00.000Z', 'Fix login'),
          touch('a2', 'doc-1', 'created', '2026-07-29T10:01:00.000Z', 'Runbook', 'doc'),
          touch('a3', 'task-1', 'updated', '2026-07-29T10:02:00.000Z', 'Fix login'),
        ]}
        anchorId={SESSION}
        anchorNoun="this session"
      />,
    );
    const toggle = screen.getByRole('button', { name: /live graph/i });
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    expect(toggle.textContent).toContain('2 entities');
    expect(toggle.textContent).toContain('3 touches');

    fireEvent.click(toggle);
    expect(toggle.getAttribute('aria-expanded')).toBe('true');
    expect(screen.getByRole('img', { name: /this session touched 2 entities/i })).toBeTruthy();
    expect(screen.getByRole('button', { name: /task: fix login — updated ×2/i })).toBeTruthy();
    expect(screen.getByRole('button', { name: /doc: runbook — created/i })).toBeTruthy();
    cleanup();
  });

  it('clicking a node opens the entity through the wired handler', () => {
    const opened: string[] = [];
    render(
      <LiveToolGraph
        items={[touch('a1', 'task-1', 'updated', '2026-07-29T10:00:00.000Z', 'Fix login')]}
        anchorId={SESSION}
        anchorNoun="this session"
        onOpenEntity={(id) => opened.push(id)}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: /live graph/i }));
    fireEvent.click(screen.getByRole('button', { name: /task: fix login/i }));
    expect(opened).toEqual(['task-1']);
    cleanup();
  });
});
