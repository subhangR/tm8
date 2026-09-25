// @vitest-environment jsdom
/**
 * useJevSuggestions — the state machine behind ✦ Ask Jev on both surfaces.
 *
 * The load-bearing claims (design 01a0cb80 §3.3, §5, lane U brief):
 *   · one run per mount; one requestId per press or re-ask;
 *   · four groups, each with its own state — one failing never touches another,
 *     and each retries alone;
 *   · `no_key` everywhere (or a node that predates the handler) is `unavailable`;
 *   · a teammate change re-asks memories, skills and references ONLY, in the
 *     same run — and never re-applies anything;
 *   · a draft edit after an answer is `stale`, and the ticks survive it;
 *   · APPLY (Jev UX lane A) replaces Jev mode: ticks are Jev's proposal, and
 *     only an Apply click writes them into a group's ordinary edit — nothing
 *     applied means nothing sent; every Apply has an Undo and a ledger entry;
 *   · the meter's numbers: Σ promptBytes of the CURRENT ticks plus the group
 *     frame for skills and references while the context index is on.
 */
import { useState } from 'react';
import { describe, expect, it } from 'vitest';
import { act, renderHook, waitFor } from '@testing-library/react';
import { CollabError, SPAWN_SELECTION_GROUP_LIMIT, type EntityId, type LaunchSuggestDraft } from '@tm8/contract';
import { contextGroupFrameBytes } from '@tm8/prompt';

import { createFixtureSeam } from '../data/fixtures/seam-fixture';
import {
  composeLaunchSelection,
  manualOutcome,
  NO_SELECTION_EDITS,
  type LaunchContextRow,
  type LaunchGroupDefaults,
  type LaunchGroupEdit,
  type LaunchSelectionDefaults,
  type LaunchSelectionEdits,
} from '../domain/launch-selection';
import type { JevPort } from './port';
import {
  answer,
  BOUND_MEMORIES,
  cost,
  failedGroup,
  item,
  MEMORIES,
  MODEL,
  okGroup,
  pendingPort,
  REFERENCES,
  REFERENCES_OFF,
  SKILLS,
} from './test-support';
import {
  JEV_NO_HOST_REASON,
  JEV_CHANGED_BY_HAND,
  JEV_REPLACED_UNDO_REASON,
  JEV_TEAMMATE_CHANGED_REASON,
  TICK_CEILING_REASON,
  useJevSuggestions,
  type JevEntityGroup,
  type JevModelChoice,
} from './useJevSuggestions';

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
      defaultReasons: { memories: 'jev-pending', skills: 'jev-pending', references: 'jev-pending' },
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

describe('a teammate change re-asks memories, skills and references', () => {
  it('only those three, same runId, new requestId, the new teammate named', async () => {
    const port = pendingPort();
    const { result, rerender } = mount({ port, teammateId: 'tm-1' });
    act(() => result.current.ask());
    await act(async () => port.calls[0]!.resolve(answer(port.calls[0]!.input)));
    const modelBefore = result.current.groups.model;

    rerender({ port, teammateId: 'tm-2' });
    expect(port.calls).toHaveLength(2);
    const reask = port.calls[1]!.input;
    expect(reask.groups).toEqual(['memories', 'skills', 'references']);
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
    act(() => { result.current.toggle('memories', 'mem-c'); });
    expect(result.current.state).toBe('ready');

    rerender({ port, draft: { ...draft, description: 'Links expire after one use.' } });
    expect(result.current.state).toBe('stale');
    expect(result.current.entity.memories.ticked).toEqual(['mem-a', 'mem-b', 'mem-c']);

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

/* ------------------------------------------------------------------ APPLY */

const eid = (n: string) => n as EntityId;
const drow = (n: string, kind = 'memory'): LaunchContextRow => ({ id: eid(n), kind, title: n, text: null, derived: false, via: 'teammate' });
const ready = (kind: string, ...ids: string[]): LaunchGroupDefaults => ({ status: 'ready', rows: ids.map((n) => drow(n, kind)), total: ids.length });

/** The launch's defaults, matching test-support's `default` flags. */
const DEFAULTS: LaunchSelectionDefaults = {
  memories: ready('memory', 'mem-a', 'mem-b'),
  skills: ready('skill', 'sk-a', 'sk-b'),
  references: ready('doc', 'ref-a', 'ref-c'),
};

const SHEET_MODEL: JevModelChoice = { model: 'claude-opus-5-5', agentToolId: 'claude-code', reasoningEffort: 'xhigh' };

interface HarnessProps {
  port?: JevPort;
  defaults?: LaunchSelectionDefaults;
  withHost?: boolean;
  modelRefusal?: string | null;
  initialTeammate?: string;
  profileId?: string;
}

/**
 * A surface in miniature: the launch's edits, teammate and model live in
 * React state as they do on LaunchSheet, and the host writes them. Every
 * setEdit call is recorded, so a test can prove nothing was written.
 */
function mountApply(props: HarnessProps = {}) {
  const writes: { group: JevEntityGroup; edit: LaunchGroupEdit; rows: readonly LaunchContextRow[] }[] = [];
  let clock = 1000;
  const hook = renderHook((p: HarnessProps) => {
    const [edits, setEdits] = useState<LaunchSelectionEdits>(NO_SELECTION_EDITS);
    const [teammate, setTeammate] = useState(p.initialTeammate ?? 'tm-1');
    const [model, setModel] = useState<JevModelChoice>(SHEET_MODEL);
    const defaults = p.defaults ?? DEFAULTS;
    const jev = useJevSuggestions({
      port: p.port,
      spaceId: 'sp-1',
      subjectId: 'task-1',
      teammateId: teammate,
      ...(p.profileId ? { interactionProfileId: p.profileId } : {}),
      now: () => (clock += 1),
      host: p.withHost === false ? null : {
        defaults,
        edits,
        setEdit(group, edit, rows = []) {
          writes.push({ group, edit, rows });
          setEdits((c) => ({ ...c, [group]: edit }));
          return null;
        },
        setTeammate,
        model,
        setModel,
        modelRefusal: () => p.modelRefusal ?? null,
      },
    });
    /* What Launch would send: the ordinary per-group rule over the edits, plus
       the hook's reasons — exactly LaunchSheet's composition. */
    const send = () => {
      const fields = jev.toSpawnFields();
      const outcomes = {
        memories: manualOutcome(defaults.memories, edits.memories),
        skills: manualOutcome(defaults.skills, edits.skills),
        references: manualOutcome(defaults.references, edits.references),
      };
      return composeLaunchSelection(outcomes, fields.defaultReasons);
    };
    return { jev, edits, teammate, model, setTeammate, setEdits, send };
  }, { initialProps: props });
  return { ...hook, writes };
}

async function answeredApply(props: HarnessProps = {}, over: Parameters<typeof answer>[1] = {}, index: 'on' | 'off' = 'on') {
  const port = pendingPort();
  const h = mountApply({ ...props, port });
  act(() => h.result.current.jev.ask());
  await act(async () => port.calls[0]!.resolve(answer(port.calls[0]!.input, over, undefined, index)));
  return { ...h, port };
}

describe('review round (#828): the ledger states what the launch carries', () => {
  it('D1 — a hand re-tick after Apply takes the change out: not counted, "changed by hand", no Undo, Re-apply restores', async () => {
    const { result } = await answeredApply();
    act(() => { result.current.jev.applyGroup('skills'); });
    expect(result.current.edits.skills).toEqual({ removed: ['sk-b'], added: [] });
    expect(result.current.jev.entity.skills.carried.removed).toEqual(['sk-b']);
    expect(result.current.jev.entity.skills.replaced).toBeNull();
    // The person re-ticks sk-b by hand: the launch carries none of the Apply.
    act(() => { result.current.setEdits((c) => ({ ...c, skills: { removed: [], added: [] } })); });
    expect(result.current.jev.entity.skills.carried).toEqual({ added: [], removed: [] });
    expect(result.current.jev.entity.skills.replaced).toBe(JEV_CHANGED_BY_HAND);
    let refusal: string | null = null;
    act(() => { refusal = result.current.jev.undo('skills'); });
    expect(refusal).toBe(JEV_REPLACED_UNDO_REASON);
    expect(result.current.edits.skills).toEqual({ removed: [], added: [] });
    act(() => { result.current.jev.reapply('skills'); });
    expect(result.current.edits.skills).toEqual({ removed: ['sk-b'], added: [] });
    expect(result.current.jev.entity.skills.replaced).toBeNull();
  });

  it('D2 — Undo after a re-Apply over a different answer returns to the pre-Jev launch', async () => {
    const { result, port } = await answeredApply();
    act(() => { result.current.jev.applyGroup('references'); });
    expect(result.current.edits.references).toEqual({ removed: ['ref-c'], added: ['ref-b'] });
    act(() => result.current.jev.retry('references'));
    await act(async () => port.calls[1]!.resolve(answer(port.calls[1]!.input, {
      references: okGroup({ ...REFERENCES, items: [item('ref-x', 'doc', 2.5, true)] }),
    })));
    act(() => { result.current.jev.applyGroup('references'); });
    expect(result.current.edits.references).toEqual({ removed: ['ref-c'], added: ['ref-b', 'ref-x'] });
    // The ledger states the NET change against the pre-Jev launch, both Applies.
    expect(result.current.jev.applied.references!.added).toEqual(['ref-b', 'ref-x']);
    expect(result.current.jev.applied.references!.removed).toEqual(['ref-c']);
    act(() => { result.current.jev.undo('references'); });
    expect(result.current.edits.references).toEqual({ removed: [], added: [] });
    expect(result.current.jev.applied.references).toBeUndefined();
  });

  it('D3 — Jev is asked with the launch’s Interaction Profile, and a profile change re-asks the three groups', async () => {
    const port = pendingPort();
    const h = mountApply({ port, profileId: 'prof-1' });
    act(() => h.result.current.jev.ask());
    expect(port.calls[0]!.input.interactionProfileId).toBe('prof-1');
    await act(async () => port.calls[0]!.resolve(answer(port.calls[0]!.input)));
    h.rerender({ port, profileId: 'prof-2' });
    expect(port.calls).toHaveLength(2);
    expect(port.calls[1]!.input.groups).toEqual(['memories', 'skills', 'references']);
    expect(port.calls[1]!.input.interactionProfileId).toBe('prof-2');
    expect(port.calls[1]!.input.runId).toBe(port.calls[0]!.input.runId);
  });
});

describe('ticks are Jev’s proposal: seeded, toggled, retried', () => {
  it('memories, skills AND references are seeded from `suggested` in rank order', async () => {
    const { result } = await answeredApply();
    const { entity } = result.current.jev;
    expect(entity.memories.ticked).toEqual(['mem-a', 'mem-b']);
    expect(entity.skills.ticked).toEqual(['sk-a']);
    expect(entity.references.ticked).toEqual(['ref-a', 'ref-b']);
    // Rows are rank order, carrying Jev's reason on the unticked ones.
    expect(entity.references.rows.map((r) => [r.entityId, r.ticked, r.reason ?? null])).toEqual([
      ['ref-a', true, null], ['ref-b', true, null], ['ref-c', false, 'over-budget'], ['ref-d', false, 'below-floor'],
    ]);
  });

  it('seeding follows score, not the server’s array order', async () => {
    const shuffled = { ...REFERENCES, items: [...REFERENCES.items].reverse() };
    const { result } = await answeredApply({}, { references: okGroup(shuffled) });
    expect(result.current.jev.entity.references.ticked).toEqual(['ref-a', 'ref-b']);
  });

  it('a reference can be toggled, and retry re-asks references alone', async () => {
    const { result, port } = await answeredApply();
    act(() => { result.current.jev.toggle('references', 'ref-c'); });
    expect(result.current.jev.entity.references.ticked).toEqual(['ref-a', 'ref-b', 'ref-c']);
    act(() => result.current.jev.retry('references'));
    expect(port.calls[1]!.input.groups).toEqual(['references']);
  });

  it('no 32-memory limit: 40 suggested memories all seed; the ceiling is the group limit', async () => {
    const many = Array.from({ length: 40 }, (_, i) => item(`mem-${String(i).padStart(2, '0')}`, 'memory', 2.9 - i / 100, true));
    const { result } = await answeredApply({}, { memories: okGroup({ ...MEMORIES, items: many, considered: 40, total: 40 }) });
    expect(result.current.jev.entity.memories.ticked).toHaveLength(40);
    expect(result.current.jev.entity.memories.ticked).toHaveLength(40);
  });

  it('ticking past SPAWN_SELECTION_GROUP_LIMIT is refused with the reason', async () => {
    const n = SPAWN_SELECTION_GROUP_LIMIT;
    const many = Array.from({ length: n + 1 }, (_, i) => item(`sk-${String(i).padStart(3, '0')}`, 'skill', 2.9, i < n));
    const { result } = await answeredApply({}, { skills: okGroup({ ...SKILLS, items: many, considered: n + 1, total: n + 1 }) });
    expect(result.current.jev.entity.skills.ticked).toHaveLength(n);
    let refusal: string | null = null;
    act(() => { refusal = result.current.jev.toggle('skills', `sk-${String(n)}`); });
    expect(refusal).toBe(TICK_CEILING_REASON);
    expect(result.current.jev.tickRefusal).toMatchObject({ group: 'skills', reason: TICK_CEILING_REASON });
  });
});

describe('the meter’s numbers', () => {
  it('used bytes are Σ promptBytes of the CURRENT ticks; memories have no frame', async () => {
    const { result } = await answeredApply();
    const m = result.current.jev.entity.memories;
    expect(m.usedBytes).toBe(600);
    expect(m.frameBytes).toBe(0);
    expect(m.budget).toBe(12288);
    expect(m.budgetSource).toBe('jev');
    expect(m.floor).toBe(1.5);
    act(() => { result.current.jev.toggle('memories', 'mem-b'); });
    expect(result.current.jev.entity.memories.usedBytes).toBe(300);
  });

  it('references pay their <group> frame while the index is on, sized by the tick count', async () => {
    const { result } = await answeredApply();
    const r = result.current.jev.entity.references;
    expect(r.contextIndex).toBe('on');
    expect(r.frameBytes).toBe(contextGroupFrameBytes('references', 2));
    expect(r.usedBytes).toBe(400 + 350 + contextGroupFrameBytes('references', 2));
    expect(r.overBudget).toBe(false);
    // Ticking the over-budget default grows the frame (count 3) and overflows.
    act(() => { result.current.jev.toggle('references', 'ref-c'); });
    const after = result.current.jev.entity.references;
    expect(after.usedBytes).toBe(1350 + contextGroupFrameBytes('references', 3));
    expect(after.overBudget).toBe(true);
    // No ticks, no frame.
    for (const id of ['ref-a', 'ref-b', 'ref-c']) act(() => { result.current.jev.toggle('references', id); });
    expect(result.current.jev.entity.references.usedBytes).toBe(0);
  });

  it('skills pay the frame too, and have no budget of their own (null)', async () => {
    const { result } = await answeredApply();
    const s = result.current.jev.entity.skills;
    expect(s.usedBytes).toBe(300 + contextGroupFrameBytes('skills', 1));
    expect(s.budget).toBeNull();
    expect(s.overBudget).toBe(false);
  });

  it('index off: references are not in the prompt, count 0 bytes, no frame; memory bytes stay real', async () => {
    const { result } = await answeredApply({}, { references: okGroup(REFERENCES_OFF) }, 'off');
    const { entity, contextIndex } = result.current.jev;
    expect(contextIndex).toBe('off');
    expect(entity.references.inPrompt).toBe(false);
    expect(entity.references.usedBytes).toBe(0);
    expect(entity.references.budget).toBeNull();
    expect(entity.skills.frameBytes).toBe(0);
    expect(entity.skills.usedBytes).toBe(300);
    expect(entity.memories.inPrompt).toBe(true);
    expect(entity.memories.usedBytes).toBe(600);
  });

  it('a per-launch contextBudgets override replaces Jev’s budget and is said to', async () => {
    const port = pendingPort();
    const { result } = renderHook(() => useJevSuggestions({
      port, spaceId: 'sp-1', subjectId: 'task-1', teammateId: 'tm-1', contextBudgets: { references: 500 },
    }));
    act(() => result.current.ask());
    await act(async () => port.calls[0]!.resolve(answer(port.calls[0]!.input)));
    expect(result.current.entity.references.budget).toBe(500);
    expect(result.current.entity.references.budgetSource).toBe('override');
    expect(result.current.entity.references.overBudget).toBe(true);
  });
});

describe('Apply is the only way Jev reaches the launch', () => {
  it('answered but nothing applied: nothing is written and nothing is sent', async () => {
    const { result, writes } = await answeredApply();
    expect(writes).toEqual([]);
    expect(result.current.edits).toEqual(NO_SELECTION_EDITS);
    expect(result.current.jev.applied).toEqual({});
    expect(result.current.send()).toEqual({
      selectionReasons: { memories: 'not-asked', skills: 'not-asked', references: 'not-asked' },
    });
    expect(result.current.jev.toSpawnFields()).toEqual({ jevRunId: result.current.jev.runId });
  });

  it('applyGroup writes Jev’s ticks as the group’s edit: removed = unticked defaults, added = non-default picks', async () => {
    const { result, writes } = await answeredApply();
    expect(result.current.jev.entity.references.proposal).toEqual({ removed: ['ref-c'], added: ['ref-b'] });
    let refusal: string | null = 'x';
    act(() => { refusal = result.current.jev.applyGroup('references'); });
    expect(refusal).toBeNull();
    expect(result.current.edits.references).toEqual({ removed: ['ref-c'], added: ['ref-b'] });
    // The added row travels with its title, as plain text.
    expect(writes[0]!.rows.map((r) => [r.id, r.title])).toEqual([['ref-b', 'Invite flow mock']]);
    // The ordinary per-group send carries it; the others stay on their defaults.
    expect(result.current.send()).toEqual({
      selection: { referenceIds: ['ref-a', 'ref-b'] },
      selectionReasons: { memories: 'not-asked', skills: 'not-asked' },
    });
  });

  it('the ledger records what was applied, from which answer, and when', async () => {
    const { result } = await answeredApply();
    act(() => { result.current.jev.applyGroup('references'); });
    const entry = result.current.jev.applied.references!;
    expect(entry).toMatchObject({
      added: ['ref-b'], removed: ['ref-c'], ticks: ['ref-a', 'ref-b'],
      touched: ['ref-a', 'ref-b', 'ref-c', 'ref-d'], before: { removed: [], added: [] },
    });
    expect(entry.at).toBeGreaterThan(1000);
    expect(entry.requestId).toBe(result.current.jev.entity.references.applied?.requestId);
    expect(result.current.jev.entity.references.appliedIsCurrent).toBe(true);
    // A re-tick after Apply: the ledger stands, but it is no longer current.
    act(() => { result.current.jev.toggle('references', 'ref-b'); });
    expect(result.current.jev.entity.references.appliedIsCurrent).toBe(false);
    expect(result.current.edits.references).toEqual({ removed: ['ref-c'], added: ['ref-b'] });
  });

  it('a default the budget left out is a VISIBLE removal with its reason, never a silent drop', async () => {
    const { result } = await answeredApply({ defaults: { ...DEFAULTS, memories: ready('memory', 'mem-a', 'mem-x') } }, { memories: okGroup(BOUND_MEMORIES) });
    const m = result.current.jev.entity.memories;
    expect(m.rows.find((r) => r.entityId === 'mem-x')).toMatchObject({ default: true, ticked: false, reason: 'over-budget' });
    act(() => { result.current.jev.applyGroup('memories'); });
    expect(result.current.jev.applied.memories).toMatchObject({ removed: ['mem-x'], added: ['mem-y'] });
    expect(result.current.send().selection).toEqual({ memoryIds: ['mem-a', 'mem-y'] });
  });

  it('Apply decides only rows Jev ranked: the person’s own edits elsewhere survive', async () => {
    const { result } = await answeredApply({ defaults: { ...DEFAULTS, references: ready('doc', 'ref-a', 'ref-c', 'ref-own') } });
    act(() => { result.current.jev.applyGroup('references'); });
    expect(result.current.send().selection).toEqual({ referenceIds: ['ref-a', 'ref-own', 'ref-b'] });
  });

  it('undo per group restores the rows Apply decided, and clears the ledger entry', async () => {
    const { result } = await answeredApply();
    act(() => { result.current.jev.applyGroup('skills'); });
    expect(result.current.edits.skills).toEqual({ removed: ['sk-b'], added: [] });
    let refusal: string | null = 'x';
    act(() => { refusal = result.current.jev.undo('skills'); });
    expect(refusal).toBeNull();
    expect(result.current.edits.skills).toEqual({ removed: [], added: [] });
    expect(result.current.jev.applied.skills).toBeUndefined();
    expect(result.current.send().selection).toBeUndefined();
  });

  it('applyModel sets model, tool and effort together; undo puts the sheet’s back', async () => {
    const { result } = await answeredApply();
    expect(result.current.jev.modelMatches).toBe(false);
    act(() => { result.current.jev.applyModel(); });
    expect(result.current.model).toEqual({ model: MODEL.model, agentToolId: MODEL.agentTool, reasoningEffort: MODEL.effort });
    expect(result.current.jev.modelMatches).toBe(true);
    expect(result.current.jev.applied.model).toMatchObject({ previous: SHEET_MODEL });
    act(() => { result.current.jev.undo('model'); });
    expect(result.current.model).toEqual(SHEET_MODEL);
    expect(result.current.jev.applied.model).toBeUndefined();
  });

  it('the surface’s model refusal is folded in and refuses applyModel', async () => {
    const { result } = await answeredApply({ modelRefusal: 'Not on this node.' });
    expect(result.current.jev.modelRefusal).toBe('Not on this node.');
    let refusal: string | null = null;
    act(() => { refusal = result.current.jev.applyModel(); });
    expect(refusal).toBe('Not on this node.');
    expect(result.current.model).toEqual(SHEET_MODEL);
  });

  it('without a host every Apply is refused with a reason', async () => {
    const { result } = await answeredApply({ withHost: false });
    expect(result.current.jev.entity.memories.applyRefusal).toBe(JEV_NO_HOST_REASON);
    let refusal: string | null = null;
    act(() => { refusal = result.current.jev.applyGroup('memories'); });
    expect(refusal).toBe(JEV_NO_HOST_REASON);
  });

  it('a locked group (defaults unread) refuses Apply rather than look applied', async () => {
    const { result, writes } = await answeredApply({ defaults: { ...DEFAULTS, skills: { status: 'loading' } } });
    expect(result.current.jev.entity.skills.applyRefusal).toMatch(/Reading/);
    act(() => { result.current.jev.applyGroup('skills'); });
    expect(writes).toEqual([]);
  });

  it('a failed group never applied still says jev-failed; once applied its own edit speaks', async () => {
    const { result } = await answeredApply({}, { skills: failedGroup('timeout') });
    expect(result.current.send().selectionReasons).toMatchObject({ skills: 'jev-failed' });
    expect(result.current.jev.entity.skills.applyRefusal).not.toBeNull();
  });
});

describe('teammate: apply, re-ask, never silently re-apply', () => {
  it('applyTeammate sets Jev’s top fit; the change re-asks the three groups and writes NOTHING', async () => {
    const { result, port, writes } = await answeredApply();
    act(() => { result.current.jev.applyGroup('memories'); });
    expect(writes).toHaveLength(1);
    act(() => { result.current.jev.applyTeammate(); });
    expect(result.current.teammate).toBe('ent-tm-scout');
    expect(result.current.jev.applied.teammate).toMatchObject({ teamMemberId: 'ent-tm-scout', previous: 'tm-1' });
    expect(port.calls).toHaveLength(2);
    expect(port.calls[1]!.input.groups).toEqual(['memories', 'skills', 'references']);
    expect(port.calls[1]!.input.teamMemberId).toBe('ent-tm-scout');
    // The new answer reseeds ticks only.
    const fresh = { ...MEMORIES, items: [item('mem-z', 'memory', 2.9, true, ['teammate'])] };
    await act(async () => port.calls[1]!.resolve(answer(port.calls[1]!.input, { memories: okGroup(fresh) })));
    expect(result.current.jev.entity.memories.ticked).toEqual(['mem-z']);
    expect(writes).toHaveLength(1);
    expect(result.current.edits.memories).toEqual({ removed: [], added: [] });
    expect(result.current.jev.applied.memories).toBeDefined();
    expect(result.current.jev.entity.memories.appliedIsCurrent).toBe(false);
  });

  it('a teammate the person picks re-asks too, and applies nothing', async () => {
    const { result, port, writes } = await answeredApply();
    act(() => result.current.setTeammate('tm-9'));
    expect(port.calls[1]!.input.teamMemberId).toBe('tm-9');
    await act(async () => port.calls[1]!.resolve(answer(port.calls[1]!.input)));
    expect(writes).toEqual([]);
    expect(result.current.send().selection).toBeUndefined();
  });

  it('undo teammate goes back to the one before', async () => {
    const { result } = await answeredApply();
    act(() => { result.current.jev.applyTeammate(); });
    act(() => { result.current.jev.undo('teammate'); });
    expect(result.current.teammate).toBe('tm-1');
    expect(result.current.jev.applied.teammate).toBeUndefined();
  });
});

describe('applyAll / undoAll', () => {
  it('teammate already Jev’s pick: model and all three groups apply, and the ledger has each', async () => {
    const { result } = await answeredApply({ initialTeammate: 'ent-tm-scout' });
    let report: ReturnType<typeof result.current.jev.applyAll> | null = null;
    act(() => { report = result.current.jev.applyAll(); });
    expect(report!.applied).toEqual(['model', 'memories', 'skills', 'references']);
    expect(Object.keys(report!.skipped)).toEqual(['teammate']);
    expect(Object.keys(result.current.jev.applied).sort()).toEqual(['memories', 'model', 'references', 'skills']);
    expect(result.current.send().selection).toEqual({ skillIds: ['sk-a'], referenceIds: ['ref-a', 'ref-b'] });
    // memories: Jev ticked exactly the defaults → an empty diff → still omitted, truthfully.
    act(() => { result.current.jev.undoAll(); });
    expect(result.current.jev.applied).toEqual({});
    expect(result.current.model).toEqual(SHEET_MODEL);
    expect(result.current.edits).toEqual(NO_SELECTION_EDITS);
  });

  it('a teammate change inside applyAll skips the three groups: they were ranked for the old teammate', async () => {
    const { result, port } = await answeredApply();
    let report: ReturnType<typeof result.current.jev.applyAll> | null = null;
    act(() => { report = result.current.jev.applyAll(); });
    expect(report!.applied).toEqual(['teammate', 'model']);
    expect(report!.skipped).toMatchObject({
      memories: JEV_TEAMMATE_CHANGED_REASON, skills: JEV_TEAMMATE_CHANGED_REASON, references: JEV_TEAMMATE_CHANGED_REASON,
    });
    expect(port.calls).toHaveLength(2);
    expect(result.current.edits).toEqual(NO_SELECTION_EDITS);
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

  const ALL = {
    runId: '11111111-1111-4111-8111-111111111111',
    subjectId: 'task-1',
    teamMemberId: 'tm-1',
    groups: ['memories' as const, 'skills' as const, 'references' as const],
  };

  it('ranks references too, and the ok fill never ticks past a binding budget', async () => {
    const seam = createFixtureSeam();
    const result = await seam.commands.jev!.suggest('sp-1', { ...ALL, requestId: '44444444-4444-4444-8444-444444444444' });
    expect(result.contextIndex).toBe('on');
    const refs = result.groups.references;
    expect(refs?.status).toBe('ok');
    if (refs?.status !== 'ok') return;
    expect(refs.value.items.length).toBeGreaterThan(0);
    expect(refs.value.budget).toBe(8192);
  });

  it('tight_budget: rows above the floor are left over-budget — a default among them — and ticks fit the budget', async () => {
    const seam = createFixtureSeam();
    seam.fixtureControls.setJevScenario('tight_budget');
    const result = await seam.commands.jev!.suggest('sp-1', { ...ALL, requestId: '55555555-5555-4555-8555-555555555555' });
    const over = (['memories', 'skills', 'references'] as const).flatMap((g) => {
      const r = result.groups[g];
      return r?.status === 'ok' ? r.value.items.filter((row) => row.reason === 'over-budget') : [];
    });
    expect(over.length).toBeGreaterThan(0);
    expect(over.some((row) => row.default)).toBe(true);
    for (const g of ['memories', 'skills', 'references'] as const) {
      const r = result.groups[g];
      if (r?.status !== 'ok' || r.value.budget === null) continue;
      const ticked = r.value.items.filter((row) => row.suggested);
      const frame = g === 'memories' || ticked.length === 0 ? 0 : contextGroupFrameBytes(g, ticked.length);
      expect(ticked.reduce((sum, row) => sum + row.promptBytes, 0) + frame).toBeLessThanOrEqual(r.value.budget);
    }
  });

  it('index_off: contextIndex off, references carry 0 bytes and no budget', async () => {
    const seam = createFixtureSeam();
    seam.fixtureControls.setJevScenario('index_off');
    const result = await seam.commands.jev!.suggest('sp-1', { ...ALL, requestId: '66666666-6666-4666-8666-666666666666' });
    expect(result.contextIndex).toBe('off');
    const refs = result.groups.references;
    if (refs?.status !== 'ok') throw new Error('references should answer');
    expect(refs.value.budget).toBeNull();
    expect(refs.value.items.every((row) => row.promptBytes === 0)).toBe(true);
  });

  it('answers 501 as a CollabError the hook reads as unavailable', async () => {
    const seam = createFixtureSeam();
    seam.fixtureControls.setJevScenario('not_implemented');
    await expect(seam.commands.jev!.suggest('sp-1', {
      runId: 'r', requestId: 'q', subjectId: 's', groups: ['model'],
    })).rejects.toBeInstanceOf(CollabError);
  });
});
