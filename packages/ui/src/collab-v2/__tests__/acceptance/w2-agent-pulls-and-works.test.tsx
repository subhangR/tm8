/**
 * GOLDEN WORKFLOW 2 — AGENT PULLS & WORKS (brief §10.2).
 *
 *   agent pulls (CLI) → the task shows "pulled by 🤖 Forge · v{n} pinned" →
 *   live "working" → its progress messages land in the task thread (and in the
 *   channel embed) → a human replies with a correction mid-flight → the agent
 *   reads it and acknowledges in-thread.
 *
 * The scripted half is driven by the SIMULATION (`mock/simulation.ts`), which
 * is the app's own demo driver — so what this test exercises is exactly what a
 * viewer of the running app sees, not a parallel fixture.
 */
import { act, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { cleanup } from '@testing-library/react';
import { Simulation } from '../../mock/simulation';
import { HomeScreen } from '../../screens/home';
import { LiveBadges, WorkingAggregate } from '../../subsystems/live';
import { Thread } from '../../subsystems/thread';
import { useGraphStore } from '../../stores';
import type { MessageView } from '../../types/contract';
import {
  createRig, ingest, renderBare, resetStores, settle, type AcceptanceRig,
} from './helpers';

let rig: AcceptanceRig;

beforeEach(() => { resetStores(); rig = createRig(); });
afterEach(async () => { await settle(); });

/** Message bodies on an anchor, oldest first. */
async function bodies(anchorId: string): Promise<string[]> {
  const page = await rig.facade.getMessages(anchorId, { order: 'asc' });
  return page.items.map((m: MessageView) =>
    (m.content.kind === 'message' ? m.content.body : ''));
}

describe('WORKFLOW 2 — agent pulls & works', () => {
  it('PULL records a pinned version and the pull shows on the task badges', async () => {
    const before = await rig.facade.getEntity(rig.ids.t103);
    expect(before.badges.pulls ?? [], 'T-103 starts unpulled').toHaveLength(0);

    await rig.facade.pullEntity(rig.ids.t103, {
      pinnedVersion: before.version, actorId: rig.ids.forge,
    });

    const pulled = await rig.facade.getEntity(rig.ids.t103);
    const pull = (pulled.badges.pulls ?? [])[0];
    expect(pull, 'PullState present').toBeTruthy();
    expect(pull.actor.id).toBe(rig.ids.forge);
    expect(pull.pinnedVersion).toBe(before.version);
    expect(pull.contentStale, 'a fresh pull is not stale').toBe(false);
  });

  it('setWork("working") produces a LiveWork entry the working pulse renders', async () => {
    const t = await rig.facade.getEntity(rig.ids.t103);
    await rig.facade.pullEntity(rig.ids.t103, { pinnedVersion: t.version, actorId: rig.ids.forge });
    await rig.facade.setWork(rig.ids.t103, { status: 'working', actorId: rig.ids.forge });

    const working = await rig.facade.getEntity(rig.ids.t103);
    const live = working.badges.workingActors ?? [];
    expect(live, 'LiveWork on the task').toHaveLength(1);
    expect(live[0].actor.id).toBe(rig.ids.forge);

    // and the live badge component renders both signals off the store
    act(() => { useGraphStore.getState().ingestSummaries([working]); });
    renderBare(rig, <LiveBadges entity={working} facade={rig.facade} />);
    await waitFor(() => {
      expect(screen.getByTestId('working-aggregate').textContent).toMatch(/working/i);
    });
  });

  it('SIMULATION: the agent posts progress and it lands in the task thread', async () => {
    const sim = new Simulation(rig.facade, { intervalMs: 1 });
    const beforeCount = (await bodies(rig.ids.t104)).length;

    await act(async () => { await sim.step(); }); // 1. mira typing (presence)
    await act(async () => { await sim.step(); }); // 2. forge posts progress

    const after = await bodies(rig.ids.t104);
    expect(after.length).toBe(beforeCount + 1);
    expect(after.at(-1)).toMatch(/virtualization is in/i);

    // rendered in the real Thread, attributed to the agent
    renderBare(rig, <Thread anchorId={rig.ids.t104} variant="comments" markReadOnView={false} />);
    expect(await screen.findByText(/virtualization is in/i)).toBeInTheDocument();
    const forge = await rig.facade.getEntity(rig.ids.forge);
    await waitFor(() => {
      expect(screen.getAllByText(new RegExp(forge.title)).length).toBeGreaterThan(0);
    });
  });

  it('a human correction mid-flight and the agent ACK both land in the same thread, in order', async () => {
    const sim = new Simulation(rig.facade, { intervalMs: 1 });
    await act(async () => { await sim.step(); });
    await act(async () => { await sim.step(); }); // agent progress is now the tail

    // human correction — posted while the agent is still `working`
    const stillWorking = await rig.facade.getEntity(rig.ids.t104);
    expect(stillWorking.badges.workingActors ?? [], 'agent is mid-flight').not.toHaveLength(0);

    await rig.facade.postMessage({
      anchorId: rig.ids.t104,
      body: 'Correction: keep the rail lazy — do not prefetch edge groups on mount.',
      actorId: rig.ids.subhang,
    });
    // agent reads it and acknowledges
    await rig.facade.postMessage({
      anchorId: rig.ids.t104,
      body: 'Ack — rail stays lazy. Reverting the prefetch.',
      actorId: rig.ids.forge,
    });

    const tail = (await bodies(rig.ids.t104)).slice(-3);
    expect(tail[0]).toMatch(/virtualization is in/i);
    expect(tail[1]).toMatch(/^Correction:/);
    expect(tail[2]).toMatch(/^Ack —/);

    // the thread renders the whole exchange
    renderBare(rig, <Thread anchorId={rig.ids.t104} variant="comments" markReadOnView={false} />);
    expect(await screen.findByText(/Correction: keep the rail lazy/)).toBeInTheDocument();
    expect(await screen.findByText(/Ack — rail stays lazy/)).toBeInTheDocument();

    // the message counter moved with the conversation
    const t104 = await rig.facade.getEntity(rig.ids.t104);
    expect(t104.counters.messages).toBeGreaterThanOrEqual(3);
  });

  it('the working state aggregates ("🤖 N working") and Home shows the in-flight row live', async () => {
    const [t104] = await ingest(rig, rig.ids.t104);
    // the seed has Forge (an agent) working on T-104
    expect(t104.badges.workingActors ?? []).not.toHaveLength(0);
    renderBare(rig, <WorkingAggregate entity={t104} />);
    const agg = await screen.findByTestId('working-aggregate');
    expect(agg.textContent).toMatch(/🤖\s*1 working/);

    cleanup();
    const facadeProps = {
      facade: rig.facade, spaceId: rig.ids.space, view: 'home' as const,
      entityId: null, onOpenEntity: () => {}, onNavigate: () => {},
    };
    renderBare(rig, <HomeScreen {...facadeProps} />);
    const inFlight = await screen.findByTestId('home-inflight');
    expect(await within(inFlight).findByText(/T-104/)).toBeInTheDocument();
  });

  it('the progress message is visible through the channel embed too (living Z2 card)', async () => {
    const sim = new Simulation(rig.facade, { intervalMs: 1 });
    // run the whole script — the last step posts an {{embed:T-104}} card into #v2-build
    for (let i = 0; i < sim.totalSteps; i += 1) {
      // eslint-disable-next-line no-await-in-loop
      await act(async () => { await sim.step(); });
    }
    const feed = await bodies(rig.ids.chBuild);
    expect(feed.some((b) => b.includes(`{{embed:${rig.ids.t104}}}`)),
      'the channel feed carries a live embed of the task').toBe(true);
  });
});
