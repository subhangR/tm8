// @vitest-environment jsdom
/**
 * THE CARD OPENS ON ITS DEFAULTS AND NEVER WAITS ON A READ IT DOESN'T NEED
 * (lane E of "Tm8 Session Launch Improvements").
 *
 *  - Launch is not held by the defaults read: an untouched group is omitted
 *    from the spawn, so the read only ever blocks a group the person EDITED,
 *    and the words name that group.
 *  - With this browser's last answer, the very FIRST render draws it — no
 *    frame of "loading", no empty strip that then fills.
 *  - The node's answer merges in silently when it matches, and with one line
 *    when it doesn't.
 */
import { describe, expect, it, vi } from 'vitest';
import { act, renderHook, waitFor } from '@testing-library/react';
import type { EntityId, LaunchDefaultsResult } from '@tm8/contract';

import { LAUNCH_DEFAULTS } from '../views/launch-fixtures';
import type { LaunchContextRow } from '../domain/launch-selection';
import type { LoadLaunchDefaults } from './port';
import { useLaunchSelection } from './useLaunchSelection';

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => { resolve = res; });
  return { promise, resolve };
}

/** A loader whose answers the test releases, with an optional cached answer behind `peek`. */
function loader(cached: LaunchDefaultsResult | null = null) {
  const pending: Array<ReturnType<typeof deferred<LaunchDefaultsResult>>> = [];
  const read = vi.fn(() => { const d = deferred<LaunchDefaultsResult>(); pending.push(d); return d.promise; });
  const load: LoadLaunchDefaults = Object.assign(read, { peek: vi.fn(() => cached) });
  return { load, read, answer: (result: LaunchDefaultsResult) => act(async () => { pending.shift()!.resolve(result); }) };
}

const WITH_EXTRA_SKILL: LaunchDefaultsResult = {
  ...LAUNCH_DEFAULTS,
  skills: {
    ...LAUNCH_DEFAULTS.skills,
    items: [...LAUNCH_DEFAULTS.skills.items, { entityId: 'ent-sk-new', kind: 'skill', title: 'graphify', via: 'teammate', headerText: null, headerSource: null, promptBytes: 120 }],
    total: 2,
  },
};

const memoryRow = (id: string): LaunchContextRow => ({ id: id as EntityId, kind: 'memory', title: id, text: null, derived: false, via: null });

describe('Launch is enabled before the defaults resolve', () => {
  it('nothing cached, the read still in flight: groups are loading and Launch is NOT blocked', () => {
    const { load, read } = loader();
    const { result } = renderHook(() => useLaunchSelection({ load, teammateId: 'tm-1', subjectId: 'task-1' }));
    expect(read).toHaveBeenCalledTimes(1);
    expect(result.current.defaults.memories).toEqual({ status: 'loading' });
    expect(result.current.launchBlock).toBeNull();
    // An untouched group is omitted from the spawn whatever the read says.
    expect(result.current.outcomes()).toEqual({ memories: { omit: 'not-asked' }, skills: { omit: 'not-asked' }, references: { omit: 'not-asked' } });
  });

  it('only an EDITED group waits on the read, and the wait names it', async () => {
    const cached = loader(LAUNCH_DEFAULTS);
    const { result } = renderHook(() => useLaunchSelection({ load: cached.load, teammateId: 'tm-1', subjectId: 'task-1' }));
    expect(result.current.launchBlock).toBeNull();
    act(() => { result.current.toggle('memories', memoryRow('ent-mem-tokens')); });
    expect(result.current.launchBlock).toBe('Reading this launch’s memories defaults… Launch waits so your edits to them are kept.');
    await cached.answer(LAUNCH_DEFAULTS);
    expect(result.current.launchBlock).toBeNull();
    expect(result.current.outcomes().memories).toEqual({ send: [] });
  });
});

describe('cached defaults on the first frame', () => {
  it('the FIRST render already draws this browser’s last answer — never a loading frame', () => {
    const { load } = loader(LAUNCH_DEFAULTS);
    const statuses: string[] = [];
    renderHook(() => {
      const selection = useLaunchSelection({ load, teammateId: 'tm-1', subjectId: 'task-1' });
      statuses.push(selection.defaults.references.status);
      return selection;
    });
    expect(statuses[0]).toBe('cached');
    expect(statuses).not.toContain('loading');
  });

  it('a matching answer merges in SILENTLY: the rows become confirmed and no note is said', async () => {
    const { load, answer } = loader(LAUNCH_DEFAULTS);
    const { result } = renderHook(() => useLaunchSelection({ load, teammateId: 'tm-1', subjectId: 'task-1' }));
    await answer(LAUNCH_DEFAULTS);
    expect(result.current.defaults.skills.status).toBe('ready');
    expect(result.current.updatedNote).toBeNull();
  });

  it('a different answer replaces the rows in place and says so in ONE line', async () => {
    const { load, answer } = loader(LAUNCH_DEFAULTS);
    const { result } = renderHook(() => useLaunchSelection({ load, teammateId: 'tm-1', subjectId: 'task-1' }));
    await answer(WITH_EXTRA_SKILL);
    const skills = result.current.defaults.skills;
    expect(skills.status === 'ready' && skills.rows.map((r) => r.id)).toEqual(['ent-sk-review', 'ent-sk-new']);
    expect(result.current.updatedNote).toBe('This launch’s defaults changed since you last opened it: skills +1.');
  });

  it('an edit made on cached rows survives the confirmation as the same diff', async () => {
    const { load, answer } = loader(LAUNCH_DEFAULTS);
    const { result } = renderHook(() => useLaunchSelection({ load, teammateId: 'tm-1', subjectId: 'task-1' }));
    act(() => { result.current.toggle('skills', { id: 'ent-sk-review' as EntityId, kind: 'skill', title: 'code-review', text: null, derived: false, via: null }); });
    expect(result.current.launchBlock).toMatch(/skills defaults/);
    await answer(WITH_EXTRA_SKILL);
    expect(result.current.launchBlock).toBeNull();
    // The removal stands; the default the node added since is KEPT, not dropped unseen.
    expect(result.current.outcomes().skills).toEqual({ send: ['ent-sk-new'] });
  });
});

describe('one read per launch key', () => {
  it('a teammate change opens the new key; the old key’s late answer never lands on it', async () => {
    const { load, answer } = loader();
    const { result, rerender } = renderHook(({ teammate }) => useLaunchSelection({ load, teammateId: teammate, subjectId: 'task-1' }), { initialProps: { teammate: 'tm-1' } });
    rerender({ teammate: 'tm-2' });
    await answer(WITH_EXTRA_SKILL); // tm-1's answer, late
    expect(result.current.defaults.skills).toEqual({ status: 'loading' });
    await answer(LAUNCH_DEFAULTS); // tm-2's
    expect(result.current.defaults.skills.status === 'ready' && result.current.defaults.skills.total).toBe(1);
  });

  it('a host that rebuilds its loader does not re-read: the read is keyed on the launch, not the function', () => {
    const first = loader();
    const { rerender } = renderHook(({ load }) => useLaunchSelection({ load, teammateId: 'tm-1', subjectId: 'task-1' }), { initialProps: { load: first.load } });
    const rebuilt = loader();
    rerender({ load: rebuilt.load });
    expect(first.read).toHaveBeenCalledTimes(1);
    expect(rebuilt.read).not.toHaveBeenCalled();
  });

  it('with no teammate there is nothing to read, and the groups say why', async () => {
    const { load, read } = loader();
    const { result } = renderHook(() => useLaunchSelection({ load, teammateId: null, subjectId: 'task-1' }));
    expect(read).not.toHaveBeenCalled();
    await waitFor(() => expect(result.current.defaults.memories).toEqual({ status: 'unknown', reason: 'Pick a teammate to see what this launch loads by default.' }));
  });
});
