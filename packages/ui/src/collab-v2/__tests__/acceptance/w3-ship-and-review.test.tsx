/**
 * GOLDEN WORKFLOW 3 — SHIP & REVIEW (brief §10.3).
 *
 *   agent links a PR (`tracks` edge + PR entity on the rail) → sets in_review →
 *   the reviewer opens the task panel and the PR panel SIDE BY SIDE (pinned
 *   splits) → stars the work → hits Complete, tagging the completers → points
 *   award moment → leaderboard / feed update → unblock ripple to the dependent
 *   task (badges clear exactly once, notifications fire).
 *
 * Seed shape this leans on: T-105 has a HARD `depends_on` T-104, so completing
 * T-104 is the unblock ripple.
 */
import { act, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup } from '@testing-library/react';
import { BlockedBadge } from '../../subsystems/live';
import { MAX_PINNED, useGraphStore, useNavStore } from '../../stores';
import { MAX_SPLITS } from '../../shell';
import type { EntitySummary, NotificationItem, WorkspaceEvent } from '../../types/contract';
import {
  createRig, edgeIndex, ingest, renderApp, renderBare, resetStores, settle, type AcceptanceRig,
} from './helpers';

let rig: AcceptanceRig;

beforeEach(() => { resetStores(); rig = createRig(); });
afterEach(async () => { await settle(); });

/**
 * `completeTask` refuses while acceptance criteria are open (a real invariant,
 * mock/world.ts:1731) — the reviewer ticks them off first, exactly as the
 * simulation's `subhang-checks-last-criterion` step does.
 */
async function closeCriteria(taskId: string): Promise<void> {
  const detail = await rig.facade.getEntity(taskId);
  if (detail.content.kind !== 'task') return;
  const criteria = detail.content.acceptanceCriteria;
  if (criteria.length === 0) return;
  await rig.facade.patchTask(taskId, {
    expectedVersion: detail.version,
    actorId: rig.ids.subhang,
    acceptanceCriteria: criteria.map((c) => ({ ...c, done: true, doneBy: c.doneBy ?? rig.ids.subhang })),
  });
}

describe('WORKFLOW 3 — ship & review', () => {
  it('linkPr creates the PR entity AND the tracks edge in one command', async () => {
    const result = await rig.facade.linkPr(rig.ids.t106, {
      url: 'https://github.com/maestro/core/pull/999', actorId: rig.ids.scout,
    });
    expect(result.entity, 'the PR summary rides back on the result').toBeTruthy();
    expect(result.entity!.kind).toBe('pull_request');

    const edges = await edgeIndex(rig, rig.ids.t106);
    expect(edges['outgoing:tracks'], 'tracks edge from the task to the PR')
      .toContain(result.entity!.id);
  });

  it('linkPr upserts by URL — linking the same PR twice does not fork the entity', async () => {
    const url = 'https://github.com/maestro/core/pull/999';
    const a = await rig.facade.linkPr(rig.ids.t106, { url, actorId: rig.ids.scout });
    const b = await rig.facade.linkPr(rig.ids.t107, { url, actorId: rig.ids.scout });
    expect(b.entity!.id).toBe(a.entity!.id);
  });

  it('in_review fires a review_request notification on the durable stream', async () => {
    // asserted on the stream rather than getInbox(): the inbox is filtered to
    // the VIEWER, and the recipient here is the task owner, who may not be the
    // seeded viewer. The contract event is the viewer-independent truth.
    const seen: NotificationItem[] = [];
    const stop = rig.facade.subscribe(rig.ids.space, (e: WorkspaceEvent) => {
      if (e.type === 'notification.created') seen.push(e.notification);
    });
    await rig.facade.setWork(rig.ids.t106, { status: 'in_review', actorId: rig.ids.scout });
    stop();

    const review = seen.find((n) => n.kind === 'review_request');
    expect(review, `review_request fired (kinds: ${seen.map((n) => n.kind).join(',')})`).toBeTruthy();
    expect(review!.target?.id).toBe(rig.ids.t106);
  });

  it('the reviewer pins the task AND the PR as side-by-side splits (capped at MAX_SPLITS)', async () => {
    const linked = await rig.facade.linkPr(rig.ids.t106, {
      url: 'https://github.com/maestro/core/pull/999', actorId: rig.ids.scout,
    });
    const prId = linked.entity!.id;
    await ingest(rig, rig.ids.t106, prId, rig.ids.docSpec, rig.ids.t105);

    const app = renderApp(rig);
    act(() => {
      useNavStore.getState().pushPanel({ entityId: rig.ids.t106 });
      useNavStore.getState().pinPanel(rig.ids.t106);
      useNavStore.getState().pushPanel({ entityId: prId });
      useNavStore.getState().pinPanel(prId);
    });

    const nav = useNavStore.getState();
    expect(nav.pinned.map((p) => p.entityId), 'task + PR docked side by side')
      .toEqual([rig.ids.t106, prId]);

    // BOTH panel bodies are on screen at once — that is what "side by side" means
    const t106 = await rig.facade.getEntity(rig.ids.t106);
    await waitFor(() => {
      expect(screen.getAllByText(t106.title).length).toBeGreaterThan(0);
    });
    await waitFor(() => {
      expect(screen.getAllByText(linked.entity!.title).length).toBeGreaterThan(0);
    });

    // the cap holds and the two constants agree
    expect(MAX_SPLITS).toBe(MAX_PINNED);
    act(() => {
      useNavStore.getState().pinPanel(rig.ids.docSpec);
    });
    expect(useNavStore.getState().pinned).toHaveLength(MAX_PINNED);
    const overflow = useNavStore.getState().pinPanel(rig.ids.t105);
    expect(overflow, 'the 4th pin is refused, not silently dropped').toBe(false);
    expect(useNavStore.getState().pinned).toHaveLength(MAX_PINNED);

    app.disconnect();
  });

  it('the pinned split layout survives a deep link (URL round-trip)', () => {
    act(() => {
      useNavStore.getState().setSpace(rig.ids.space);
      useNavStore.getState().pushPanel({ entityId: rig.ids.t106 });
      useNavStore.getState().pinPanel(rig.ids.t106);
      useNavStore.getState().pushPanel({ entityId: rig.ids.pr248 });
      useNavStore.getState().pinPanel(rig.ids.pr248);
    });
    const hash = useNavStore.getState().toHash();
    act(() => { useNavStore.getState().reset(); });
    expect(useNavStore.getState().pinned).toHaveLength(0);
    act(() => { useNavStore.getState().hydrateFromHash(hash); });
    expect(useNavStore.getState().pinned.map((p) => p.entityId))
      .toEqual([rig.ids.t106, rig.ids.pr248]);
  });

  it('starring the work is recorded as the viewer reaction', async () => {
    await rig.facade.setReaction(rig.ids.t104, {
      reaction: 'star', enabled: true, actorId: rig.ids.subhang,
    });
    const starred = await rig.facade.getEntity(rig.ids.t104);
    expect(starred.counters.stars).toBeGreaterThanOrEqual(1);
  });

  it('COMPLETE fires the award, moves the leaderboard, and ripples the unblock — badges clear exactly once', async () => {
    // pre-state. The award pool is the task's own points (mock/world.ts:1743) —
    // i.e. exactly the bounty workflow 1 staged.
    await closeCriteria(rig.ids.t104);
    const t104before = await rig.facade.getEntity(rig.ids.t104);
    const bounty = t104before.counters.points;
    expect(bounty, 'the seeded bounty is the award pool').toBeGreaterThan(0);
    const t105before = await rig.facade.getEntity(rig.ids.t105);
    expect(t105before.badges.blocked, 'T-105 starts blocked on T-104').toBeTruthy();
    expect(t105before.badges.blocked!.waitingOn.map((e) => e.id)).toContain(rig.ids.t104);

    const boardBefore = await rig.facade.getLeaderboard(rig.ids.space);
    const forgeBefore = boardBefore.items.find((r) => r.actor.id === rig.ids.forge)!;

    // watch the durable stream so "exactly once" is measurable
    const t105Upserts: EntitySummary[] = [];
    const notes: NotificationItem[] = [];
    const stop = rig.facade.subscribe(rig.ids.space, (e: WorkspaceEvent) => {
      if (e.type === 'entity.upsert' && e.entity.id === rig.ids.t105) t105Upserts.push(e.entity);
      if (e.type === 'notification.created') notes.push(e.notification);
    });

    await rig.facade.completeTask(rig.ids.t104, {
      expectedVersion: t104before.version,
      completerIds: [rig.ids.forge],
      actorId: rig.ids.subhang,
    });
    stop();

    // (a) the task is done (workStatus lives on EntityState, not content)
    const t104after = await rig.facade.getEntity(rig.ids.t104);
    expect(t104after.state.kind).toBe('task');
    if (t104after.state.kind === 'task') expect(t104after.state.workStatus).toBe('done');

    // (b) award moment — the point event exists, attributed to the completer.
    // The TASK arrives in `ref` (contract: "the task that generated an award").
    // NOTE / defect filed to Atlas: for reason='award' the mock sets
    // `onEntity` to the RECIPIENT (mock/world.ts:2377 maps pe.entityId, which
    // completeTask sets to the completer), so onEntity duplicates `recipient`
    // instead of naming what the points were granted on. AwardsFeed reads
    // `ref`, so no UI is broken today — but the field is misleading.
    const awards = await rig.facade.getAwards(rig.ids.space);
    const award = awards.items.find(
      (a) => a.reason === 'award' && a.recipient.id === rig.ids.forge
        && a.ref?.id === rig.ids.t104,
    );
    expect(award, 'award point-event for the completer on this task').toBeTruthy();
    expect(award!.amount).toBe(bounty);
    expect(award!.onEntity?.id, 'documented divergence: onEntity is the recipient, not the task')
      .toBe(rig.ids.forge);

    // (c) leaderboard moved by exactly the award
    const boardAfter = await rig.facade.getLeaderboard(rig.ids.space);
    const forgeAfter = boardAfter.items.find((r) => r.actor.id === rig.ids.forge)!;
    expect(forgeAfter.score).toBe(forgeBefore.score + award!.amount);

    // (d) unblock ripple — T-105's blocked badge is GONE
    const t105after = await rig.facade.getEntity(rig.ids.t105);
    expect(t105after.badges.blocked, 'T-105 is unblocked').toBeFalsy();

    // (e) ...and the stream announced it EXACTLY ONCE (no duplicate ripple)
    const clearing = t105Upserts.filter((e) => !e.badges.blocked);
    expect(clearing.length, 'exactly one badge-clearing upsert for T-105').toBe(1);

    // (f) the completion + unblock fired notifications on the stream
    expect(notes.some((n) => n.kind === 'unblock'),
      `unblock notification (kinds seen: ${[...new Set(notes.map((n) => n.kind))].join(',')})`).toBe(true);
    expect(notes.some((n) => n.kind === 'award'),
      `award notification (kinds seen: ${[...new Set(notes.map((n) => n.kind))].join(',')})`).toBe(true);
  });

  it('the unblock moment is a one-shot UI event — BlockedBadge fires onUnblocked once', async () => {
    const [t105] = await ingest(rig, rig.ids.t105);
    const onUnblocked = vi.fn();
    renderBare(rig, <BlockedBadge entity={t105} onUnblocked={onUnblocked} />);
    expect(await screen.findByText(/blocked/i)).toBeInTheDocument();

    await closeCriteria(rig.ids.t104);
    const t104 = await rig.facade.getEntity(rig.ids.t104);
    await act(async () => {
      await rig.facade.completeTask(rig.ids.t104, {
        expectedVersion: t104.version, completerIds: [rig.ids.forge], actorId: rig.ids.subhang,
      });
      // push the fresh summary into the store the badge subscribes to
      useGraphStore.getState().ingestSummaries([await rig.facade.getEntity(rig.ids.t105)]);
    });

    await waitFor(() => expect(onUnblocked).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(screen.queryByText(/⚠/)).toBeNull());
  });

  it('the reviewer path end-to-end through the shell: pinned splits + complete + leaderboard row', async () => {
    const app = renderApp(rig);
    await ingest(rig, rig.ids.t104, rig.ids.pr241);
    act(() => {
      useNavStore.getState().pushPanel({ entityId: rig.ids.t104 });
      useNavStore.getState().pinPanel(rig.ids.t104);
      useNavStore.getState().pushPanel({ entityId: rig.ids.pr241 });
      useNavStore.getState().pinPanel(rig.ids.pr241);
    });
    await waitFor(() => expect(useNavStore.getState().pinned).toHaveLength(2));

    await closeCriteria(rig.ids.t104);
    const t104 = await rig.facade.getEntity(rig.ids.t104);
    await act(async () => {
      await rig.facade.completeTask(rig.ids.t104, {
        expectedVersion: t104.version, completerIds: [rig.ids.forge], actorId: rig.ids.subhang,
      });
    });

    // navigate to the leaderboard screen and read the bumped row.
    // NOTE (minor, filed): screen root testids follow TWO conventions —
    // `view-<name>` (home/tasks/inbox/channel/tracking/settings) vs
    // `<name>-screen` (docs/team/leaderboard). Harmless but inconsistent.
    act(() => { useNavStore.getState().setView('leaderboard'); });
    const board = await screen.findByTestId('leaderboard-screen');
    const forge = await rig.facade.getEntity(rig.ids.forge);
    await waitFor(() => {
      expect(within(board).getAllByText(new RegExp(forge.title)).length).toBeGreaterThan(0);
    });

    app.disconnect();
  });
});
