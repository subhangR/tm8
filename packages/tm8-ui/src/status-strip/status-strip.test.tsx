// @vitest-environment jsdom
import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { NodeMetricsView, SpaceId } from '@tm8/contract';

import type { LivenessSnapshot, Seam } from '../data/seam';
import { StatusStrip } from './StatusStrip';
import { HOST_MS, LIVENESS_MS } from './useStatusStrip';
import { formatBytes, formatPercent, toneOfFraction } from './format';

const SPACE = '00000000-0000-4000-8000-0000000000aa' as SpaceId;
const GB = 1024 ** 3;

function metrics(over: Partial<NodeMetricsView> = {}): NodeMetricsView {
  return {
    sampledAt: '2026-09-26T07:00:00.000Z',
    cpu: { percent: 23.4, cores: 10 },
    memory: { totalBytes: 16 * GB, usedBytes: 14.8 * GB },
    loadAverage: [5.46, 7.93, 7.01],
    disk: { path: '/data', totalBytes: 1000 * GB, usedBytes: 810 * GB },
    process: { rssBytes: 412 * 1024 ** 2, heapUsedBytes: 200 * 1024 ** 2, uptimeSeconds: 3725 },
    hostUptimeSeconds: 100_000,
    ...over,
  };
}

function snapshot(over: Partial<LivenessSnapshot> = {}): LivenessSnapshot {
  return {
    spaceId: SPACE,
    liveEntityIds: ['a', 'b', 'c'],
    nodeBootId: 'boot',
    checkedAt: '2026-09-26T07:00:00.000Z',
    eventHwm: 1,
    liveSessionCount: 2,
    liveChatCount: 3,
    workingChatCount: 1,
    ...over,
  };
}

interface FakeSeam {
  seam: Seam;
  nodeMetrics: ReturnType<typeof vi.fn>;
  refresh: ReturnType<typeof vi.fn>;
  emit(snap: LivenessSnapshot): void;
}

function fakeSeam(opts: {
  host?: () => Promise<NodeMetricsView>;
  live?: () => Promise<LivenessSnapshot>;
  noHostRead?: boolean;
} = {}): FakeSeam {
  const subs = new Set<(s: LivenessSnapshot) => void>();
  const nodeMetrics = vi.fn(opts.host ?? (async () => metrics()));
  const refresh = vi.fn(opts.live ?? (async () => snapshot()));
  const seam = {
    ...(opts.noHostRead ? {} : { nodeMetrics }),
    liveness: {
      refresh,
      onChange(cb: (s: LivenessSnapshot) => void) {
        subs.add(cb);
        return () => subs.delete(cb);
      },
      statusOf: () => 'unknown',
    },
  } as unknown as Seam;
  return { seam, nodeMetrics, refresh, emit: (s) => subs.forEach((cb) => cb(s)) };
}

function setVisibility(state: 'visible' | 'hidden') {
  Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => state });
  document.dispatchEvent(new Event('visibilitychange'));
}

const text = (testId: string) => screen.getByTestId(testId).textContent;

beforeEach(() => setVisibility('visible'));
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe('StatusStrip — order and content', () => {
  it('renders lead slot FIRST, then CPU, memory, load, disk, tm8, sessions, chats', async () => {
    const { seam } = fakeSeam();
    render(<StatusStrip seam={seam} spaceId={SPACE} leadSlot={<span data-testid="lead">!</span>} />);
    await waitFor(() => expect(screen.queryByTestId('status-strip-cpu')).not.toBeNull());
    const strip = screen.getByTestId('status-strip');
    const order = [...strip.children].map((el) => el.getAttribute('data-testid'));
    expect(order).toEqual([
      'lead',
      'status-strip-cpu',
      'status-strip-memory',
      'status-strip-load',
      'status-strip-disk',
      'status-strip-rss',
      'status-strip-sessions',
      'status-strip-chats',
    ]);
    expect(text('status-strip-cpu')).toBe('CPU23%');
    expect(text('status-strip-memory')).toBe('Mem14.8 / 16 GB');
    expect(text('status-strip-load')).toBe('Load5.46');
    expect(text('status-strip-disk')).toBe('Disk81%');
    expect(text('status-strip-rss')).toBe('tm8412 MB');
  });

  /* The in-bar ladder (`shell.css`) hides `--shed-N` in ascending N as the
     top bar narrows. Pinned here because jsdom cannot see the ladder itself:
     a renumbered segment would silently change what the owner loses first. */
  it('carries the in-bar shed order: tm8, disk, load, mem, cpu, chats, sessions', async () => {
    const { seam } = fakeSeam();
    render(<StatusStrip seam={seam} spaceId={SPACE} placement="bar" />);
    await waitFor(() => expect(screen.queryByTestId('status-strip-cpu')).not.toBeNull());
    expect(screen.getByTestId('status-strip').className).toContain('status-strip--in-bar');
    const shedOf = (id: string) => /--shed-(\d)/.exec(screen.getByTestId(id).className)?.[1];
    expect(
      ['rss', 'disk', 'load', 'memory', 'cpu', 'chats', 'sessions'].map((k) => shedOf(`status-strip-${k}`)),
    ).toEqual(['1', '2', '3', '4', '5', '6', '7']);
  });

  it('defaults to its own row', async () => {
    const { seam } = fakeSeam();
    render(<StatusStrip seam={seam} spaceId={SPACE} />);
    expect(screen.getByTestId('status-strip').className).not.toContain('status-strip--in-bar');
  });

  it('live sessions and chats come from the liveness counts, with working as a suffix', async () => {
    const { seam } = fakeSeam();
    render(<StatusStrip seam={seam} spaceId={SPACE} />);
    await waitFor(() => expect(text('status-strip-sessions')).toBe('Sessions2'));
    // NOT liveEntityIds.length (3): the PTY map can hold a session whose
    // record says it ended; the server's both-truths count is the answer.
    expect(text('status-strip-chats')).toBe('Chats3 · 1 working');
  });

  it('zero chats reads 0 — a measured zero, not a hidden segment', async () => {
    const { seam } = fakeSeam({ live: async () => snapshot({ liveChatCount: 0, workingChatCount: 0 }) });
    render(<StatusStrip seam={seam} spaceId={SPACE} />);
    await waitFor(() => expect(text('status-strip-chats')).toBe('Chats0'));
  });

  it('an older node (no counts) reads a dash, never zero', async () => {
    const { seam } = fakeSeam({
      live: async () => snapshot({ liveSessionCount: null, liveChatCount: null, workingChatCount: null }),
    });
    render(<StatusStrip seam={seam} spaceId={SPACE} />);
    await waitFor(() => expect(screen.getByTestId('status-strip').getAttribute('data-testid')).toBe('status-strip'));
    await waitFor(() => expect(text('status-strip-sessions')).toBe('Sessions—'));
    expect(text('status-strip-chats')).toBe('Chats—');
  });

  it('a snapshot for ANOTHER space never lands on this strip', async () => {
    const f = fakeSeam();
    render(<StatusStrip seam={f.seam} spaceId={SPACE} />);
    await waitFor(() => expect(text('status-strip-sessions')).toBe('Sessions2'));
    act(() => f.emit(snapshot({ spaceId: 'other' as SpaceId, liveSessionCount: 99 })));
    expect(text('status-strip-sessions')).toBe('Sessions2');
    act(() => f.emit(snapshot({ liveSessionCount: 5 })));
    expect(text('status-strip-sessions')).toBe('Sessions5');
  });
});

describe('StatusStrip — node-admin gate', () => {
  it('a forbidden host read hides the host segments and stops asking', async () => {
    vi.useFakeTimers();
    const f = fakeSeam({ host: async () => { throw Object.assign(new Error('no'), { code: 'forbidden' }); } });
    render(<StatusStrip seam={f.seam} spaceId={SPACE} />);
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    expect(screen.queryByTestId('status-strip-cpu')).toBeNull();
    expect(screen.queryByTestId('status-strip-memory')).toBeNull();
    // The counts still render for a non-admin.
    expect(text('status-strip-sessions')).toBe('Sessions2');
    await act(async () => { await vi.advanceTimersByTimeAsync(HOST_MS * 4); });
    expect(f.nodeMetrics).toHaveBeenCalledTimes(1);
  });

  it('a seam with no host read renders only the counts', async () => {
    const f = fakeSeam({ noHostRead: true });
    render(<StatusStrip seam={f.seam} spaceId={SPACE} />);
    await waitFor(() => expect(text('status-strip-sessions')).toBe('Sessions2'));
    expect(screen.queryByTestId('status-strip-cpu')).toBeNull();
  });

  it('a transient failure keeps the last reading and says so in the tooltip', async () => {
    vi.useFakeTimers();
    let fail = false;
    const f = fakeSeam({
      host: async () => {
        if (fail) throw Object.assign(new Error('down'), { code: 'upstream_unavailable' });
        return metrics();
      },
    });
    render(<StatusStrip seam={f.seam} spaceId={SPACE} />);
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    expect(text('status-strip-cpu')).toBe('CPU23%');
    fail = true;
    await act(async () => { await vi.advanceTimersByTimeAsync(HOST_MS); });
    expect(text('status-strip-cpu')).toBe('CPU23%');
    expect(screen.getByTestId('status-strip-cpu').getAttribute('title')).toContain('latest read failed');
  });
});

describe('StatusStrip — polling', () => {
  it('polls host and liveness on their cadences and PAUSES while the tab is hidden', async () => {
    vi.useFakeTimers();
    const f = fakeSeam();
    render(<StatusStrip seam={f.seam} spaceId={SPACE} />);
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    expect(f.nodeMetrics).toHaveBeenCalledTimes(1);
    expect(f.refresh).toHaveBeenCalledTimes(1);

    await act(async () => { await vi.advanceTimersByTimeAsync(LIVENESS_MS); });
    expect(f.nodeMetrics).toHaveBeenCalledTimes(1 + LIVENESS_MS / HOST_MS);
    expect(f.refresh).toHaveBeenCalledTimes(2);

    act(() => setVisibility('hidden'));
    const hostCalls = f.nodeMetrics.mock.calls.length;
    const liveCalls = f.refresh.mock.calls.length;
    await act(async () => { await vi.advanceTimersByTimeAsync(LIVENESS_MS * 4); });
    expect(f.nodeMetrics).toHaveBeenCalledTimes(hostCalls);
    expect(f.refresh).toHaveBeenCalledTimes(liveCalls);

    // Visible again: one immediate read of each, then the cadence resumes.
    act(() => setVisibility('visible'));
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    expect(f.nodeMetrics).toHaveBeenCalledTimes(hostCalls + 1);
    expect(f.refresh).toHaveBeenCalledTimes(liveCalls + 1);
  });

  it('stops every timer on unmount', async () => {
    vi.useFakeTimers();
    const f = fakeSeam();
    const { unmount } = render(<StatusStrip seam={f.seam} spaceId={SPACE} />);
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    unmount();
    const before = f.nodeMetrics.mock.calls.length + f.refresh.mock.calls.length;
    await vi.advanceTimersByTimeAsync(LIVENESS_MS * 3);
    expect(f.nodeMetrics.mock.calls.length + f.refresh.mock.calls.length).toBe(before);
  });
});

describe('format', () => {
  it('bytes, percent and tone', () => {
    expect(formatBytes(16 * GB)).toBe('16 GB');
    expect(formatBytes(14.83 * GB)).toBe('14.8 GB');
    expect(formatBytes(412 * 1024 ** 2)).toBe('412 MB');
    expect(formatBytes(null)).toBe('—');
    expect(formatPercent(0.234)).toBe('23%');
    expect(formatPercent(null)).toBe('—');
    expect(toneOfFraction(0.5)).toBe('normal');
    expect(toneOfFraction(0.8)).toBe('warn');
    expect(toneOfFraction(0.95)).toBe('alert');
  });
});
