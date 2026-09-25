// @vitest-environment jsdom
/**
 * useJevSuggestions — the state machine behind ✦ Ask Jev on both surfaces.
 *
 * The load-bearing claims (design 01a0cb80 §3.3, §5, lane U brief):
 *   · one run per mount; one requestId per press or re-ask;
 *   · four groups, each with its own state — one failing never touches another,
 *     and each retries alone;
 *   · `no_key` everywhere (or a node that predates the handler) is `unavailable`;
 *   · a teammate change re-asks memories and skills ONLY, in the same run;
 *   · a draft edit after an answer is `stale`, and the ticks survive it;
 *   · `toSpawnFields` decides memories and skills PER GROUP (I9, replacing the
 *     "both sets or nothing" ruling): an answered group is its exact ticked
 *     set, a failed or pending one is omitted with `jev-failed`/`jev-pending`,
 *     and never is a group sent as `[]` while its set is unknown.
 */
import { describe, expect, it } from 'vitest';
import { act, renderHook, waitFor } from '@testing-library/react';
import { CollabError, type LaunchSuggestDraft } from '@tm8/contract';

import { createFixtureSeam } from '../data/fixtures/seam-fixture';
import { MEMORY_IDS_MAX } from '../domain/memory';
import type { JevPort } from './port';
import {
  answer,
  cost,
  failedGroup,
  item,
  okGroup,
  pendingPort,
  SKILLS,
} from './test-support';
import { MEMORY_LIMIT_REASON, useJevSuggestions } from './useJevSuggestions';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

interface Props {
  port?: JevPort;
  teammateId?: string | null;
  draft?: LaunchSuggestDraft;
}

function mount(initial: Props) {
  return renderHook((p: Props) => useJevSuggestions({
    port: p.port,
    spaceId: 'sp-1',
    subjectId: 'task-1',
    teammateId: p.teammateId ?? 'tm-1',
    draft: p.draft,
  }), { initialProps: initial });
}

describe('states', () => {
  it('starts idle, with a stable uuid run and nothing for spawn', () => {
    const { result, rerender } = mount({ port: pendingPort() });
    expect(result.current.state).toBe('idle');
    expect(result.current.runId).toMatch(UUID);
    const runId = result.current.runId;
    rerender({ port: pendingPort() });
    expect(result.current.runId).toBe(runId);
    // Never asked ⇒ the launch is today's, byte for byte.
    expect(result.current.toSpawnFields()).toEqual({});
  });

  it('ask() sends all five groups (I7 added references) in ONE request, and every group shows asking', () => {
    const port = pendingPort();
    const { result } = mount({ port });
    act(() => result.current.ask());
    expect(port.calls).toHaveLength(1);
    const input = port.calls[0]!.input;
    expect(input.groups).toEqual(['model', 'teammates', 'memories', 'skills', 'references']);
    expect(input.runId).toBe(result.current.runId);
    expect(input.requestId).toMatch(UUID);
    expect(input.subjectId).toBe('task-1');
    expect(input.teamMemberId).toBe('tm-1');
    // The sheet reads the saved subject: no draft is sent.
    expect('draft' in input).toBe(false);
    expect(result.current.state).toBe('asking');
    for (const g of ['model', 'teammates', 'memories', 'skills', 'references'] as const) {
      expect(result.current.groups[g].status).toBe('asking');
    }
  });

  it('ask(groups) sends only that subset', () => {
    const port = pendingPort();
    const { result } = mount({ port });
    act(() => result.current.ask(['model']));
    expect(port.calls[0]!.input.groups).toEqual(['model']);
    expect(result.current.groups.teammates.status).toBe('idle');
  });

  it('asking → ready, with every group ok and the run total from the answer', async () => {
    const port = pendingPort();
    const { result } = mount({ port });
    act(() => result.current.ask());
    await act(async () => port.calls[0]!.resolve(answer(port.calls[0]!.input)));
    expect(result.current.state).toBe('ready');
    expect(result.current.groups.model.status).toBe('ok');
    expect(result.current.run).toEqual(cost(7, 0.00021, 1100));
  });

  it('launching while still asking sends today’s defaults — no groups, pending named as the reason', () => {
    const port = pendingPort();
    const { result } = mount({ port });
    act(() => result.current.ask());
    expect(result.current.toSpawnFields()).toEqual({
      defaultReasons: { memories: 'jev-pending', skills: 'jev-pending' },
      jevRunId: result.current.runId,
    });
  });
});

describe('groups are independent', () => {
  it('all five go out together through the fixture and settle on their own: skills fails, the rest stand', async () => {
    const seam = createFixtureSeam();
    seam.fixtureControls.setJevScenario('group_failed');
    const { result } = mount({ port: seam.commands.jev });
    act(() => result.current.ask());
    await waitFor(() => expect(result.current.state).toBe('ready'));
    const requests = seam.fixtureControls.jevRequests();
    expect(requests).toHaveLength(1);
    expect(requests[0]!.groups).toEqual(['model', 'teammates', 'memories', 'skills', 'references']);
    expect(result.current.groups.skills).toMatchObject({ status: 'failed', reason: 'timeout' });
    // The failed call was still costed.
    expect(result.current.groups.skills.status === 'failed' && result.current.groups.skills.cost.calls).toBe(1);
    expect(result.current.groups.model.status).toBe('ok');
    expect(result.current.groups.teammates.status).toBe('ok');
    expect(result.current.groups.memories.status).toBe('ok');
  });

  it('retry(group) re-asks that group alone, in the same run, and leaves the others untouched', async () => {
    const seam = createFixtureSeam();
    seam.fixtureControls.setJevScenario('group_failed');
    const { result } = mount({ port: seam.commands.jev });
    act(() => result.current.ask());
    await waitFor(() => expect(result.current.state).toBe('ready'));
    const modelBefore = result.current.groups.model;

    seam.fixtureControls.setJevScenario('ok');
    act(() => result.current.retry('skills'));
    expect(result.current.groups.skills.status).toBe('asking');
    expect(result.current.groups.model).toBe(modelBefore);
    await waitFor(() => expect(result.current.groups.skills.status).toBe('ok'));

    const [first, second] = seam.fixtureControls.jevRequests();
    expect(second!.groups).toEqual(['skills']);
    expect(second!.runId).toBe(first!.runId);
    expect(second!.requestId).not.toBe(first!.requestId);
    expect(result.current.groups.model).toBe(modelBefore);
  });

  it('a thrown request fails only the groups it carried', async () => {
    const port = pendingPort();
    const { result } = mount({ port });
    act(() => result.current.ask(['model']));
    act(() => result.current.ask(['skills']));
    await act(async () => port.calls[0]!.reject(new TypeError('fetch failed')));
    await act(async () => port.calls[1]!.resolve(answer(port.calls[1]!.input)));
    expect(result.current.groups.model).toMatchObject({ status: 'failed', reason: 'network' });
    expect(result.current.groups.skills.status).toBe('ok');
  });

  it('an older answer that lands after a re-ask is dropped for that group', async () => {
    const port = pendingPort();
    const { result } = mount({ port });
    act(() => result.current.ask(['skills']));
    act(() => result.current.retry('skills'));
    await act(async () => port.calls[1]!.resolve(answer(port.calls[1]!.input)));
    await act(async () => port.calls[0]!.resolve(answer(port.calls[0]!.input, { skills: failedGroup('timeout') })));
    expect(result.current.groups.skills.status).toBe('ok');
  });
});

describe('unavailable', () => {
  it('every group failing with no_key is unavailable (fixture: no TYPESAFE_API_KEY)', async () => {
    const seam = createFixtureSeam();
    seam.fixtureControls.setJevScenario('no_key');
    const { result } = mount({ port: seam.commands.jev });
    act(() => result.current.ask());
    await waitFor(() => expect(result.current.state).toBe('unavailable'));
  });

  it('a node that predates the handler (501 not_implemented) is unavailable too', async () => {
    const seam = createFixtureSeam();
    seam.fixtureControls.setJevScenario('not_implemented');
    const { result } = mount({ port: seam.commands.jev });
    act(() => result.current.ask());
    await waitFor(() => expect(result.current.state).toBe('unavailable'));
  });

  it('one group without a key among ok groups is NOT unavailable', async () => {
    const port = pendingPort();
    const { result } = mount({ port });
    act(() => result.current.ask());
    await act(async () => port.calls[0]!.resolve(answer(port.calls[0]!.input, { model: failedGroup('no_key') })));
    expect(result.current.state).toBe('ready');
  });

  it('no port is refused with a reason, and pressing sends nothing', () => {
    const { result } = mount({});
    expect(result.current.askRefusal).toMatch(/isn’t wired/);
    act(() => result.current.ask());
    expect(result.current.state).toBe('idle');
  });
});

describe('a teammate change re-asks memories and skills', () => {
  it('only those two, same runId, new requestId, the new teammate named', async () => {
    const port = pendingPort();
    const { result, rerender } = mount({ port, teammateId: 'tm-1' });
    act(() => result.current.ask());
    await act(async () => port.calls[0]!.resolve(answer(port.calls[0]!.input)));
    const modelBefore = result.current.groups.model;

    rerender({ port, teammateId: 'tm-2' });
    expect(port.calls).toHaveLength(2);
    const reask = port.calls[1]!.input;
    expect(reask.groups).toEqual(['memories', 'skills']);
    expect(reask.runId).toBe(port.calls[0]!.input.runId);
    expect(reask.requestId).not.toBe(port.calls[0]!.input.requestId);
    expect(reask.teamMemberId).toBe('tm-2');
    expect(result.current.groups.memories.status).toBe('asking');
    expect(result.current.groups.model).toBe(modelBefore);
    expect(result.current.groups.teammates.status).toBe('ok');
  });

  it('before any answer, a teammate change asks nothing', () => {
    const port = pendingPort();
    const { rerender } = mount({ port, teammateId: 'tm-1' });
    rerender({ port, teammateId: 'tm-2' });
    expect(port.calls).toHaveLength(0);
  });
});

describe('staleness', () => {
  it('a draft edit after an answer is stale; ticks are kept; Ask again returns to ready', async () => {
    const port = pendingPort();
    const draft = { title: 'Fix the join screen', description: 'Links expire.' };
    const { result, rerender } = mount({ port, draft });
    act(() => result.current.ask());
    expect(port.calls[0]!.input.draft).toEqual(draft);
    await act(async () => port.calls[0]!.resolve(answer(port.calls[0]!.input)));
    act(() => { result.current.toggle('memory', 'mem-c'); });
    expect(result.current.state).toBe('ready');

    rerender({ port, draft: { ...draft, description: 'Links expire after one use.' } });
    expect(result.current.state).toBe('stale');
    expect(result.current.ticked.memory).toEqual(['mem-a', 'mem-b', 'mem-c']);

    act(() => result.current.ask());
    expect(port.calls[1]!.input.draft).toEqual({ ...draft, description: 'Links expire after one use.' });
    await act(async () => port.calls[1]!.resolve(answer(port.calls[1]!.input)));
    expect(result.current.state).toBe('ready');
  });

  it('a title edit is stale too', async () => {
    const port = pendingPort();
    const draft = { title: 'A', description: 'B' };
    const { result, rerender } = mount({ port, draft });
    act(() => result.current.ask());
    await act(async () => port.calls[0]!.resolve(answer(port.calls[0]!.input)));
    rerender({ port, draft: { title: 'A2', description: 'B' } });
    expect(result.current.state).toBe('stale');
  });
});

describe('selection and toSpawnFields', () => {
  async function answered(over: Parameters<typeof answer>[1] = {}) {
    const port = pendingPort();
    const hook = mount({ port });
    act(() => hook.result.current.ask());
    await act(async () => port.calls[0]!.resolve(answer(port.calls[0]!.input, over)));
    return { ...hook, port };
  }

  it('ticks are seeded from `suggested`, exactly', async () => {
    const { result } = await answered();
    expect(result.current.jevMode).toBe(true);
    expect(result.current.ticked.memory).toEqual(['mem-a', 'mem-b']);
    expect(result.current.ticked.skill).toEqual(['sk-a']);
  });

  it('sends exactly the ticked ids with the run, and never memoryIds', async () => {
    const { result } = await answered();
    act(() => { result.current.toggle('memory', 'mem-b'); });
    act(() => { result.current.toggle('skill', 'sk-b'); });
    const fields = result.current.toSpawnFields();
    expect(fields).toEqual({
      groups: { memories: { send: ['mem-a'] }, skills: { send: ['sk-a', 'sk-b'] } },
      jevRunId: result.current.runId,
    });
    expect('memoryIds' in fields).toBe(false);
  });

  it('reset leaves Jev mode: no selection, the run still linked for cost', async () => {
    const { result } = await answered();
    act(() => result.current.reset());
    expect(result.current.jevMode).toBe(false);
    expect(result.current.ticked).toEqual({ memory: [], skill: [] });
    expect(result.current.toSpawnFields()).toEqual({ jevRunId: result.current.runId });
  });

  it('a teammate change after Reset does not quietly put Jev mode back', async () => {
    const { result, rerender, port } = await answered();
    act(() => result.current.reset());
    rerender({ port, teammateId: 'tm-2' });
    expect(port.calls).toHaveLength(1);
    expect(result.current.jevMode).toBe(false);
  });

  it('a failed skills group is omitted as jev-failed while the memories still go, and says why', async () => {
    const { result } = await answered({ skills: failedGroup('timeout') });
    expect(result.current.jevMode).toBe(true);
    expect(result.current.toSpawnFields()).toEqual({
      groups: { memories: { send: ['mem-a', 'mem-b'] }, skills: { omit: 'jev-failed' } },
      jevRunId: result.current.runId,
    });
    expect(result.current.launchNote).toMatch(/Skills failed \(timeout\)/);
    expect(result.current.launchNote).toMatch(/other ticks still go/);
    expect(result.current.launchNote).toMatch(/Retry/);
  });

  it('a skipped group truthfully has no candidates, so it sends []', async () => {
    const { result } = await answered({ skills: { status: 'skipped', reason: 'no_candidates', cost: cost(0, 0, 0) } });
    expect(result.current.toSpawnFields().groups).toEqual({ memories: { send: ['mem-a', 'mem-b'] }, skills: { send: [] } });
    expect(result.current.launchNote).toBeNull();
  });

  it('while a teammate re-ask is in flight, both groups are withheld as jev-pending', async () => {
    const { result, rerender, port } = await answered();
    rerender({ port, teammateId: 'tm-2' });
    expect(result.current.toSpawnFields()).toEqual({
      groups: { memories: { omit: 'jev-pending' }, skills: { omit: 'jev-pending' } },
      jevRunId: result.current.runId,
    });
    expect(result.current.launchNote).toMatch(/still answering/);
  });
});

describe('the 32-memory limit', () => {
  const many = (n: number, suggested: boolean) => Array.from({ length: n }, (_, i) =>
    item(`mem-${String(i).padStart(2, '0')}`, 'memory', 2.9 - i / 100, suggested));

  it('ticking a 33rd memory is refused with the reason, and nothing changes', async () => {
    const port = pendingPort();
    const { result } = mount({ port });
    act(() => result.current.ask());
    const items = [...many(MEMORY_IDS_MAX, true), ...many(40, false).slice(MEMORY_IDS_MAX)];
    await act(async () => port.calls[0]!.resolve(answer(port.calls[0]!.input, {
      memories: okGroup({ items, considered: items.length, total: items.length }),
    })));
    expect(result.current.ticked.memory).toHaveLength(MEMORY_IDS_MAX);
    let refusal: string | null = null;
    act(() => { refusal = result.current.toggle('memory', 'mem-35'); });
    expect(refusal).toBe(MEMORY_LIMIT_REASON);
    expect(result.current.tickRefusal).toEqual({ kind: 'memory', id: 'mem-35', reason: MEMORY_LIMIT_REASON });
    expect(result.current.ticked.memory).toHaveLength(MEMORY_IDS_MAX);
    expect(result.current.ticked.memory).not.toContain('mem-35');
    // Unticking one makes room again.
    act(() => { result.current.toggle('memory', 'mem-00'); });
    act(() => { result.current.toggle('memory', 'mem-35'); });
    expect(result.current.ticked.memory).toContain('mem-35');
  });

  it('seeding never ticks more than 32, even if more come back suggested', async () => {
    const port = pendingPort();
    const { result } = mount({ port });
    act(() => result.current.ask());
    const items = many(40, true);
    await act(async () => port.calls[0]!.resolve(answer(port.calls[0]!.input, {
      memories: okGroup({ items, considered: 40, total: 40 }),
      skills: okGroup(SKILLS),
    })));
    expect(result.current.ticked.memory).toHaveLength(MEMORY_IDS_MAX);
    expect(result.current.ticked.memory[0]).toBe('mem-00');
  });
});

describe('the fixture port models the server contract', () => {
  it('a repeated requestId returns the recorded answer without charging the run again', async () => {
    const seam = createFixtureSeam();
    const input = {
      runId: '11111111-1111-4111-8111-111111111111',
      requestId: '22222222-2222-4222-8222-222222222222',
      subjectId: 'task-1',
      teamMemberId: 'tm-1',
      groups: ['model' as const],
    };
    const first = await seam.commands.jev!.suggest('sp-1', input);
    const again = await seam.commands.jev!.suggest('sp-1', input);
    expect(again).toEqual(first);
    const next = await seam.commands.jev!.suggest('sp-1', { ...input, requestId: '33333333-3333-4333-8333-333333333333' });
    expect(next.run.calls).toBe(first.run.calls * 2);
  });

  it('answers 501 as a CollabError the hook reads as unavailable', async () => {
    const seam = createFixtureSeam();
    seam.fixtureControls.setJevScenario('not_implemented');
    await expect(seam.commands.jev!.suggest('sp-1', {
      runId: 'r', requestId: 'q', subjectId: 's', groups: ['model'],
    })).rejects.toBeInstanceOf(CollabError);
  });
});
