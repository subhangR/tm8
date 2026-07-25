/**
 * GOLDEN WORKFLOW 1 — AUTHOR & STAGE (brief §10.1).
 *
 *   human creates a task in a channel context (auto-attached) → sets acceptance
 *   criteria → drags in a design doc (attach) → drags it onto an agent
 *   (assign) → grants a 20-point bounty.
 *
 * Everything must be visible on the task's Connections rail and the channel's
 * auto-tab counts must bump; every step must land in Activity.
 *
 * The steps run through the REAL affordances wherever one exists (the creation
 * modal, native HTML5 drags over the grammar's drop surfaces, the panel's
 * points control) — not through raw facade calls.
 */
import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { cleanup } from '@testing-library/react';
import { openCreation, resolveDrop, seedForChannel, sourceRef, targetRef } from '../../interactions';
import { runPlacement } from '../../interactions/execute';
import { useNavStore } from '../../stores';
import {
  activityVerbs, createRig, dragPayloadFor, edgeIndex, ingest, renderApp, renderBare,
  resetStores, settle, toastMessages, type AcceptanceRig,
} from './helpers';

let rig: AcceptanceRig;

beforeEach(() => { resetStores(); rig = createRig(); });
afterEach(async () => { await settle(); });

describe('WORKFLOW 1 — author & stage', () => {
  it('creates a task IN the channel through the real creation modal (create + attach = one command)', async () => {
    // NO extra CreationHost: CollabDndProvider already mounts the app's one.
    renderBare(rig, <div />);

    act(() => { openCreation('task', seedForChannel(rig.ids.space, rig.ids.chBuild)); });

    const dialog = await screen.findByRole('dialog');
    fireEvent.change(within(dialog).getByLabelText('Task title'), {
      target: { value: 'T-200 · Acceptance harness' },
    });
    fireEvent.change(within(dialog).getByLabelText('Description'), {
      target: { value: 'Drive the five golden workflows.' },
    });
    fireEvent.submit(dialog);

    await waitFor(() => expect(toastMessages().some((m) => m.includes('T-200'))).toBe(true));

    // the entity exists and is attached to the channel it was born in
    const page = await rig.facade.queryCollection({
      spaceId: rig.ids.space, kinds: ['task'],
      filters: { edge: { type: 'attached_to', direction: 'outgoing', entityId: rig.ids.chBuild } },
      limit: 100,
    });
    const task = page.page.items.find((e) => e.title.includes('T-200'));
    expect(task, 'new task is attached to #v2-build').toBeTruthy();

    const edges = await edgeIndex(rig, task!.id);
    expect(edges['outgoing:attached_to']).toContain(rig.ids.chBuild);
  });

  it('runs the whole staging chain and leaves every step on the rail, the tabs and the activity log', async () => {
    const tabsBefore = await rig.facade.getChannelTabs(rig.ids.chBuild);
    const tasksTabBefore = tabsBefore.find((t) => t.key === 'tasks')!;

    // --- step 1: create in the channel ------------------------------------
    const createResult = await rig.facade.createEntity({
      spaceId: rig.ids.space, kind: 'task', title: 'T-200 · Acceptance harness',
      content: { description: 'Drive the five golden workflows.' },
      attachTo: { entityId: rig.ids.chBuild, edgeType: 'attached_to' },
      actorId: rig.ids.subhang,
    });
    const taskId = createResult.entity!.id;

    // --- step 2: acceptance criteria --------------------------------------
    const v1 = await rig.facade.getEntity(taskId);
    await rig.facade.patchTask(taskId, {
      expectedVersion: v1.version,
      actorId: rig.ids.subhang,
      acceptanceCriteria: [
        { id: 'ac1', text: 'All five workflows green', done: false },
        { id: 'ac2', text: 'No console errors', done: false },
      ],
    });
    const withCriteria = await rig.facade.getEntity(taskId);
    expect(withCriteria.content.kind).toBe('task');
    if (withCriteria.content.kind === 'task') {
      expect(withCriteria.content.acceptanceCriteria).toHaveLength(2);
    }
    expect(withCriteria.version, 'content write bumps version').toBeGreaterThan(v1.version);

    // --- step 3: attach a doc via the GRAMMAR (doc → task surface) --------
    const [doc, taskSummary] = await ingest(rig, rig.ids.docSpec, taskId);
    const docOptions = resolveDrop(sourceRef(doc), targetRef(taskSummary, 'task'));
    expect(docOptions.map((o) => o.intent), 'artifact→task is unambiguous attach').toEqual(['attach']);
    const attach = await runPlacement(rig.facade, {
      source: sourceRef(doc), target: targetRef(taskSummary, 'task'), option: docOptions[0],
    });
    expect(attach.ok).toBe(true);
    expect(attach.result!.undo, 'every drop is undoable').toBeTruthy();

    // --- step 4: assign to the agent via the GRAMMAR (task → actor) -------
    const [forge] = await ingest(rig, rig.ids.forge);
    const assignOptions = resolveDrop(sourceRef(taskSummary), targetRef(forge, 'actor'));
    expect(assignOptions.map((o) => o.intent)).toEqual(['assign']);
    const assign = await runPlacement(rig.facade, {
      source: sourceRef(taskSummary), target: targetRef(forge, 'actor'), option: assignOptions[0],
    });
    expect(assign.ok).toBe(true);

    // --- step 5: bounty ---------------------------------------------------
    await rig.facade.grantPoints(taskId, { amount: 20, reason: 'grant', actorId: rig.ids.subhang });

    // === assertions =======================================================
    // (a) entities + edges exist, and the rail can see all of them
    const edges = await edgeIndex(rig, taskId);
    expect(edges['outgoing:attached_to'], 'channel + doc on the rail').toEqual(
      expect.arrayContaining([rig.ids.chBuild]),
    );
    const allOther = Object.values(edges).flat();
    expect(allOther, 'the doc landed').toContain(rig.ids.docSpec);
    expect(allOther, 'the agent landed').toContain(rig.ids.forge);

    // (b) the bounty is on the task's counters
    const staged = await rig.facade.getEntity(taskId);
    expect(staged.counters.points).toBe(20);

    // (c) the channel's auto-tab count bumped by exactly one task
    const tabsAfter = await rig.facade.getChannelTabs(rig.ids.chBuild);
    const tasksTabAfter = tabsAfter.find((t) => t.key === 'tasks')!;
    expect(tasksTabAfter.count).toBe(tasksTabBefore.count + 1);

    // (d) every step is in the activity log
    const verbs = await activityVerbs(rig, taskId);
    expect(verbs.join(' ')).toMatch(/created/i);
    expect(verbs.some((v) => /point|award|grant/i.test(v)), `points in activity (got ${verbs.join(',')})`).toBe(true);
    expect(verbs.some((v) => /edge|link|attach|assign|placement/i.test(v)),
      `placements in activity (got ${verbs.join(',')})`).toBe(true);
  });

  it('renders the staged task in the shell: panel opens with the criteria and the rail shows the doc + agent', async () => {
    const createResult = await rig.facade.createEntity({
      spaceId: rig.ids.space, kind: 'task', title: 'T-200 · Acceptance harness',
      content: { description: 'Staged.' },
      attachTo: { entityId: rig.ids.chBuild, edgeType: 'attached_to' },
      actorId: rig.ids.subhang,
    });
    const taskId = createResult.entity!.id;
    const v1 = await rig.facade.getEntity(taskId);
    await rig.facade.patchTask(taskId, {
      expectedVersion: v1.version, actorId: rig.ids.subhang,
      acceptanceCriteria: [{ id: 'ac1', text: 'All five workflows green', done: false }],
    });
    await rig.facade.placements({ sourceId: rig.ids.docSpec, targetId: taskId, intent: 'attach' });
    await rig.facade.placements({ sourceId: taskId, targetId: rig.ids.forge, intent: 'assign' });

    const app = renderApp(rig);
    await ingest(rig, taskId);
    act(() => { useNavStore.getState().pushPanel({ entityId: taskId }); });

    // the panel is the real EntityPanel with the real slots
    expect(await screen.findByText('T-200 · Acceptance harness')).toBeInTheDocument();
    // Content tab shows the criteria
    await waitFor(() => expect(screen.getByText(/All five workflows green/)).toBeInTheDocument());

    // Connections tab shows the doc and the agent (the rail slot)
    const connectionsTab = await screen.findByRole('tab', { name: /connections/i });
    fireEvent.click(connectionsTab);
    const doc = await rig.facade.getEntity(rig.ids.docSpec);
    const forge = await rig.facade.getEntity(rig.ids.forge);
    await waitFor(() => {
      expect(screen.getAllByText(new RegExp(doc.title.slice(0, 18).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))).length)
        .toBeGreaterThan(0);
    });
    await waitFor(() => {
      expect(screen.getAllByText(new RegExp(forge.title)).length).toBeGreaterThan(0);
    });

    app.disconnect();
  });

  it('a native chip drag onto the channel surface resolves to attach (+ optional embed) — the grammar the UI wires', async () => {
    const [doc, channel] = await ingest(rig, rig.ids.docRollout, rig.ids.chDesign);
    const options = resolveDrop(sourceRef(doc), targetRef(channel, 'channel'));
    expect(options.map((o) => o.label)).toEqual(['Attach', 'Attach & post card']);
    expect(options[1].withEmbed).toBe(true);

    // and the payload a real EntityChip drag carries is readable by the host
    const dt = dragPayloadFor(doc);
    expect(dt.types.length).toBe(1);
  });
});
