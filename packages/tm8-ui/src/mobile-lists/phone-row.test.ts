import { describe, expect, it } from 'vitest';
import type { EntitySummary } from '@tm8/contract';
import { matchesSearch, moreUrgent, phoneRowOf, phoneTime, phoneTree } from './phone-row';

const NOW = Date.parse('2026-10-18T12:00:00Z');
const ago = (ms: number) => new Date(NOW - ms).toISOString();
const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

function summary(over: Partial<EntitySummary> & { state: EntitySummary['state'] }): EntitySummary {
  return {
    id: over.id ?? 'e1',
    spaceId: 's1',
    kind: over.state.kind,
    title: 'A title',
    parentId: null,
    position: 0,
    visibility: 'space',
    version: 1,
    activityAt: ago(4 * MIN),
    createdAt: ago(DAY * 3),
    updatedAt: ago(4 * MIN),
    deletedAt: null,
    createdBy: { id: 'a1', kind: 'member', displayName: 'Subhang', isAgent: false },
    counters: { likes: 0, dislikes: 0, stars: 0, points: 0, messages: 0, viewerReaction: null },
    badges: {},
    ...over,
  } as EntitySummary;
}

describe('phoneTime — the compact trailing time', () => {
  it('reads now / minutes / hours / yesterday / weekday / date', () => {
    const local = new Date(NOW);
    const midnight = new Date(local).setHours(0, 0, 0, 0);
    expect(phoneTime(ago(10_000), NOW)).toBe('now');
    expect(phoneTime(ago(4 * MIN), NOW)).toBe('4m');
    if (NOW - 2 * HOUR >= midnight) expect(phoneTime(ago(2 * HOUR), NOW)).toBe('2h');
    expect(phoneTime(new Date(midnight - HOUR).toISOString(), NOW)).toBe('yesterday');
    expect(phoneTime(new Date(midnight - 3 * DAY).toISOString(), NOW)).toMatch(/^[A-Z][a-z]{2}$/);
    expect(phoneTime(new Date(midnight - 30 * DAY).toISOString(), NOW)).toMatch(/\d/);
  });

  it('is empty, not "Invalid Date", for a missing instant', () => {
    expect(phoneTime(null, NOW)).toBe('');
    expect(phoneTime('nope', NOW)).toBe('');
  });
});

describe('phoneRowOf — one anatomy, filled per kind', () => {
  it('sessions: owner on the meta line, idle reads "waiting"', () => {
    const row = phoneRowOf(
      summary({ state: { kind: 'work_session', status: 'idle', agentTool: null, model: null, shareMode: 'private' } as never }),
      NOW,
    );
    expect(row.meta).toBe('Subhang');
    expect(row.who?.initial).toBe('S');
    expect(row.pill).toEqual({ label: 'waiting', tone: 'wait' });
    expect(row.tint).toBe('session');
  });

  it('tasks: assignee, status pill and P-rank', () => {
    const row = phoneRowOf(
      summary({
        state: {
          kind: 'task',
          status: 'blocked',
          priority: 'urgent',
          axes: {},
          assignees: [{ id: 'a2', kind: 'team_member', displayName: 'Worker', isAgent: true }],
          acceptance: { total: 0, completed: 0 },
        },
      }),
      NOW,
    );
    expect(row.meta).toBe('Worker');
    expect(row.pill).toEqual({ label: 'blocked', tone: 'block' });
    expect(row.rank).toEqual({ label: 'P0', hot: true });
  });

  it('tasks with nobody on them say so', () => {
    const row = phoneRowOf(
      summary({
        state: { kind: 'task', status: 'open', priority: 'low', axes: {}, assignees: [], acceptance: { total: 0, completed: 0 } },
      }),
      NOW,
    );
    expect(row.meta).toBe('Unassigned');
    expect(row.rank?.label).toBe('P3');
  });

  it('docs: excerpt as prose, author underneath, time from updatedAt', () => {
    const row = phoneRowOf(
      summary({
        excerpt: '# Heading\n\nFirst   line\nsecond',
        updatedAt: ago(2 * MIN),
        activityAt: ago(DAY * 40),
        state: { kind: 'doc', format: 'markdown', childCount: 0 },
      }),
      NOW,
    );
    expect(row.excerpt).toBe('# Heading First line second');
    expect(row.meta).toBe('Subhang');
    expect(row.time).toBe('2m');
  });

  it('channels: last message and an unread dot', () => {
    const row = phoneRowOf(
      summary({
        excerpt: 'You: ok ship it',
        state: { kind: 'channel', topic: 't', members: [], unreadCount: 3, workingAgentCount: 0 },
      }),
      NOW,
    );
    expect(row.meta).toBe('You: ok ship it');
    expect(row.unread).toBe(true);
  });

  it('chats: the last message, never blank', () => {
    const withExcerpt = phoneRowOf(summary({ excerpt: 'hello', state: { kind: 'chat', turnCount: 2 } as never }), NOW);
    const empty = phoneRowOf(summary({ state: { kind: 'chat', turnCount: 0 } as never }), NOW);
    expect(withExcerpt.meta).toBe('hello');
    expect(empty.meta).toBe('No messages yet');
  });
});

describe('phoneTree — roots with their loaded children', () => {
  const s = (id: string, parentId: string | null) =>
    summary({ id, parentId, state: { kind: 'work_session', status: 'running' } as never });

  it('folds children and grandchildren under the root, keeps orphans as roots', () => {
    const tree = phoneTree([s('r', null), s('c1', 'r'), s('g1', 'c1'), s('orphan', 'gone')]);
    expect(tree.map((n) => n.row.id)).toEqual(['r', 'orphan']);
    expect(tree[0]!.children.map((c) => c.id)).toEqual(['c1', 'g1']);
  });
});

describe('moreUrgent — a collapsed root borrows its most urgent child', () => {
  it('waiting outranks running, failed outranks both', () => {
    const run = { label: 'running', tone: 'run' as const };
    const wait = { label: 'waiting', tone: 'wait' as const };
    const fail = { label: 'failed', tone: 'block' as const };
    expect(moreUrgent(run, wait)).toBe(wait);
    expect(moreUrgent(wait, run)).toBe(wait);
    expect(moreUrgent(wait, fail)).toBe(fail);
  });
});

describe('matchesSearch', () => {
  it('matches title or excerpt, case-insensitively; blank matches all', () => {
    const r = summary({ title: 'Billing rounding', excerpt: 'ship it', state: { kind: 'doc', format: 'markdown', childCount: 0 } });
    expect(matchesSearch(r, 'ROUND')).toBe(true);
    expect(matchesSearch(r, 'ship')).toBe(true);
    expect(matchesSearch(r, 'zzz')).toBe(false);
    expect(matchesSearch(r, '  ')).toBe(true);
  });
});
