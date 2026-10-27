import { describe, expect, it } from 'vitest';
import {
  ageOf,
  kindsOf,
  madeStatusOf,
  passesFilter,
  readMemory,
  rootsOf,
  sessionByline,
  summaryOf,
  writeMemory,
} from './created-here-model';
import { madeSummary } from './created-here.test-support';

const CHAT = '019f0000-0000-7000-8000-00000000c0c0';
const id = (n: number) => `019f0000-0000-7000-8000-${String(n).padStart(12, '0')}`;

describe('rootsOf', () => {
  it('keeps roots only, never messages, forms or the chat, deduped and newest first', () => {
    const task = madeSummary({ id: id(1), kind: 'task', createdAt: '2026-10-17T10:00:00.000Z' });
    const sub = madeSummary({ id: id(2), kind: 'task', parentId: id(1) });
    const session = madeSummary({ id: id(3), kind: 'work_session', parentId: CHAT, createdAt: '2026-10-17T11:00:00.000Z' });
    const elsewhere = madeSummary({ id: id(4), kind: 'doc', parentId: id(99) });
    const message = madeSummary({ id: id(5), kind: 'message' });
    const roots = rootsOf([task, sub, session, task, elsewhere, message], CHAT);
    expect(roots.map((r) => r.id)).toEqual([id(3), id(1), id(4)]);
    expect(roots.some((r) => r.id === id(2))).toBe(false);
    expect(roots.some((r) => r.kind === 'message')).toBe(false);
  });
});

describe('kindsOf', () => {
  it('counts per kind, sessions then tasks then docs then the rest', () => {
    const kinds = kindsOf([
      madeSummary({ id: id(1), kind: 'doc' }),
      madeSummary({ id: id(2), kind: 'artifact' }),
      madeSummary({ id: id(3), kind: 'task' }),
      madeSummary({ id: id(4), kind: 'work_session' }),
      madeSummary({ id: id(5), kind: 'task' }),
    ]);
    expect(kinds).toEqual([
      { kind: 'work_session', count: 1 },
      { kind: 'task', count: 2 },
      { kind: 'doc', count: 1 },
      { kind: 'artifact', count: 1 },
    ]);
  });
});

describe('madeStatusOf', () => {
  const session = (state: Record<string, unknown>) =>
    madeSummary({ id: id(7), kind: 'work_session', state: { kind: 'work_session', agentTool: 'claude-code', model: null, shareMode: 'space', startedAt: null, exitedAt: null, ...state } as never });

  it('calls a session running only on a live verdict', () => {
    expect(madeStatusOf(session({ status: 'running' }), () => 'live').mark).toBe('running');
    expect(madeStatusOf(session({ status: 'running' }), () => 'stale').mark).toBe('open');
    expect(madeStatusOf(session({ status: 'running' })).mark).toBe('open');
  });

  it('reads a live idle session as waiting, a completed one as done, a crash as failed', () => {
    expect(madeStatusOf(session({ status: 'idle' }), () => 'live').mark).toBe('waiting');
    expect(madeStatusOf(session({ status: 'idle', outcome: 'completed' }), () => 'live')).toMatchObject({ mark: 'done', closed: false });
    expect(madeStatusOf(session({ status: 'exited', outcome: 'completed' }), () => 'not-running')).toMatchObject({ mark: 'done', closed: true });
    expect(madeStatusOf(session({ status: 'failed' }), () => 'not-running')).toMatchObject({ mark: 'failed', closed: true });
  });

  it('greys a closed task and marks a working one running', () => {
    const task = (status: string, category: string) =>
      madeSummary({ id: id(8), kind: 'task', category: category as never, state: { kind: 'task', status, priority: 'medium', axes: {}, assignees: [], acceptance: { total: 0, completed: 0 } } as never });
    expect(madeStatusOf(task('done', 'done'))).toMatchObject({ mark: 'done', closed: true });
    expect(madeStatusOf(task('working', 'in_progress'))).toMatchObject({ mark: 'running', closed: false });
    expect(madeStatusOf(task('blocked', 'in_progress')).mark).toBe('waiting');
  });

  it('summarises running and waiting, and filters by them', () => {
    const statuses = [
      madeStatusOf(session({ status: 'running' }), () => 'live'),
      madeStatusOf(session({ status: 'idle' }), () => 'live'),
      madeStatusOf(session({ status: 'exited', outcome: 'completed' }), () => 'not-running'),
    ];
    expect(summaryOf(statuses)).toEqual({ running: 1, waiting: 1 });
    expect(statuses.filter((s) => passesFilter(s, 'running'))).toHaveLength(2);
    expect(statuses.filter((s) => passesFilter(s, 'done'))).toHaveLength(1);
  });
});

describe('row text', () => {
  it('ages quietly and never negatively', () => {
    const now = Date.parse('2026-10-17T12:00:00.000Z');
    expect(ageOf('2026-10-17T11:42:00.000Z', now)).toBe('18m');
    expect(ageOf('2026-10-17T09:00:00.000Z', now)).toBe('3h');
    expect(ageOf('2026-10-15T12:00:00.000Z', now)).toBe('2d');
    expect(ageOf('2026-10-17T12:05:00.000Z', now)).toBe('now');
  });

  it('names a session by teammate and model label', () => {
    const s = madeSummary({
      id: id(9), kind: 'work_session',
      state: { kind: 'work_session', status: 'running', model: 'claude-opus-5-5[1m]', teammate: { displayName: 'Worker' } } as never,
    });
    expect(sessionByline(s, (m) => (m === 'claude-opus-5-5[1m]' ? 'Opus 5.5 1M' : m))).toBe('Worker · Opus 5.5 1M');
    expect(sessionByline(madeSummary({ id: id(10), kind: 'task' }), (m) => m)).toBeNull();
  });
});

describe('memory', () => {
  it('round-trips per chat and survives garbage', () => {
    const map = new Map<string, string>();
    const storage = { getItem: (k: string) => map.get(k) ?? null, setItem: (k: string, v: string) => void map.set(k, v) };
    writeMemory(CHAT, { expanded: true, kind: 'task' }, storage);
    expect(readMemory(CHAT, storage)).toEqual({ expanded: true, kind: 'task' });
    expect(readMemory('other', storage)).toEqual({ expanded: false, kind: null });
    map.set('tm8.chat.createdHere.bad', '{nope');
    expect(readMemory('bad', storage)).toEqual({ expanded: false, kind: null });
  });
});
