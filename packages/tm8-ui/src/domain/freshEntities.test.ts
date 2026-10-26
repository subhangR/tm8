// @vitest-environment jsdom
import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DurableWorkspaceEvent, EntitySummary } from '@tm8/contract';
import { taskGuideLines } from '../fixtures';
import {
  FRESH_MS,
  LEAVING_MS,
  LEAVING_REDUCED_MS,
  createFreshEntityStore,
  type FreshEntityStore,
} from './freshEntities';
import { retainLeaving, useFreshGlow, useRetainLeaving } from './useFreshGlow';

const T0 = Date.parse('2026-10-06T12:00:00.000Z');
let seq = 0;

function entity(id: string, createdAt: number): EntitySummary {
  return { ...taskGuideLines, id, createdAt: new Date(createdAt).toISOString() } as EntitySummary;
}

function upsert(id: string, createdAt: number, occurredAt = createdAt): DurableWorkspaceEvent {
  seq += 1;
  return {
    type: 'entity.upsert',
    entity: entity(id, createdAt),
    spaceId: taskGuideLines.spaceId,
    seq,
    occurredAt: new Date(occurredAt).toISOString(),
    schemaVersion: 1,
  } as DurableWorkspaceEvent;
}

function deleted(id: string, occurredAt: number): DurableWorkspaceEvent {
  return { ...upsert(id, T0 - 3_600_000, occurredAt), type: 'entity.deleted' } as DurableWorkspaceEvent;
}

let store: FreshEntityStore;
let reduced = false;

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(T0);
  reduced = false;
  store = createFreshEntityStore({ reducedMotion: () => reduced });
});
afterEach(() => {
  vi.useRealTimers();
});

describe('freshEntities — births', () => {
  it('a page load lights nothing: no event, no entry', () => {
    // Hydrated rows never pass through the stream; only `observe` can add one.
    expect(store.entryOf('loaded')).toBeUndefined();
    const { result } = renderHook(() => useFreshGlow('loaded', store));
    expect(result.current.phase).toBeNull();
    expect(result.current.attrs).toEqual({});
  });

  it('a live create glows, with data-fresh and a zero delay at birth', () => {
    store.observe(upsert('born', T0));
    const { result } = renderHook(() => useFreshGlow('born', store));
    expect(result.current.phase).toBe('fresh');
    expect(result.current.attrs['data-fresh']).toBe('');
    expect(result.current.attrs.style).toEqual({ '--pn-fresh-delay': '-0ms' });
    expect(result.current.srSuffix).toBe(', new');
  });

  it('an edit to an old entity is not a birth', () => {
    store.observe(upsert('old', T0 - 3_600_000, T0));
    expect(store.entryOf('old')).toBeUndefined();
  });

  it('a reconnect backfill of an old creation does not glow', () => {
    // A live event first, so the clock offset is known…
    store.observe(upsert('live', T0));
    // …then the replay of a creation from ten minutes ago.
    store.observe(upsert('replayed', T0 - 600_000));
    expect(store.entryOf('replayed')).toBeUndefined();
    expect(store.entryOf('live')?.phase).toBe('fresh');
  });

  it('a skewed client clock still glows a live create', () => {
    // The server runs 5 minutes ahead of this browser.
    store.observe(upsert('skewed', T0 + 300_000));
    expect(store.entryOf('skewed')?.phase).toBe('fresh');
    expect(store.entryOf('skewed')?.endsAt).toBe(T0 + FRESH_MS);
  });

  it('expires at 30s', () => {
    store.observe(upsert('born', T0));
    const { result } = renderHook(() => useFreshGlow('born', store));
    act(() => vi.advanceTimersByTime(FRESH_MS - 1));
    expect(result.current.phase).toBe('fresh');
    act(() => vi.advanceTimersByTime(1));
    expect(result.current.phase).toBeNull();
    expect(store.entryOf('born')).toBeUndefined();
  });

  it('a row mounting mid-life keeps the remaining time, and the delay holds across renders', () => {
    store.observe(upsert('born', T0));
    vi.advanceTimersByTime(12_000);
    const { result, rerender } = renderHook(() => useFreshGlow('born', store));
    expect(result.current.attrs.style).toEqual({ '--pn-fresh-delay': '-12000ms' });
    vi.advanceTimersByTime(5_000);
    rerender();
    // Recomputing would shift a running animation; the delay is fixed at mount.
    expect(result.current.attrs.style).toEqual({ '--pn-fresh-delay': '-12000ms' });
    act(() => vi.advanceTimersByTime(FRESH_MS - 17_000));
    expect(result.current.phase).toBeNull();
  });

  it('a second upsert of a fresh entity does not restart its glow', () => {
    store.observe(upsert('born', T0));
    vi.advanceTimersByTime(10_000);
    store.observe(upsert('born', T0, T0 + 10_000));
    expect(store.entryOf('born')?.startedAt).toBe(T0);
  });
});

describe('freshEntities — deaths', () => {
  it('a live delete is leaving, inert and aria-hidden, then gone after 2s', () => {
    store.observe(upsert('warm', T0));
    store.observe(deleted('warm', T0));
    const { result } = renderHook(() => useFreshGlow('warm', store));
    expect(result.current.phase).toBe('leaving');
    expect(result.current.attrs).toMatchObject({ 'data-leaving': '', 'aria-hidden': true, inert: true });
    expect(result.current.srSuffix).toBeNull();
    act(() => vi.advanceTimersByTime(LEAVING_MS));
    expect(result.current.phase).toBeNull();
  });

  it('under reduced motion the exit lasts 1s', () => {
    reduced = true;
    store.observe(deleted('gone', T0));
    expect(store.entryOf('gone')?.endsAt).toBe(T0 + LEAVING_REDUCED_MS);
  });

  it('a reconnect backfill of a delete does not flash', () => {
    store.observe(upsert('live', T0));
    store.observe(deleted('long-gone', T0 - 60_000));
    expect(store.isLeaving('long-gone')).toBe(false);
  });
});

describe('retaining a leaving row', () => {
  const a = { id: 'a' };
  const b = { id: 'b' };
  const c = { id: 'c' };
  const idOf = (x: { id: string }) => x.id;

  it('puts a vanished leaving row back where it was', () => {
    const leaving = { isLeaving: (id: string) => id === 'b' };
    expect(retainLeaving([a, b, c], [a, c], idOf, leaving)).toEqual([a, b, c]);
    expect(retainLeaving([b, a], [a], idOf, leaving)).toEqual([b, a]);
  });

  it('lets a row that is not leaving go at once', () => {
    const none = { isLeaving: () => false };
    const items = [a, c];
    expect(retainLeaving([a, b, c], items, idOf, none)).toBe(items);
  });

  it('drops the row when its exit ends', () => {
    let items = [a, b, c];
    const { result, rerender } = renderHook(() => useRetainLeaving(items, idOf, store));
    expect(result.current).toEqual([a, b, c]);
    store.observe(deleted('b', T0));
    items = [a, c];
    rerender();
    expect(result.current).toEqual([a, b, c]);
    act(() => vi.advanceTimersByTime(LEAVING_MS));
    expect(result.current).toEqual([a, c]);
  });
});
