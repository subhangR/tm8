/**
 * L2.5 gate — the live layer flips because the WORLD changed.
 *
 * Two kinds of proof per behaviour:
 *  • component logic driven by hand-crafted WorkspaceEvents (deterministic), and
 *  • the real narrative driven by the simulation (staleness pin → RE-PULL,
 *    completion ripple → unblock moment).
 * No component here owns a timer or fakes a transition.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, screen, waitFor } from '@testing-library/react';
import { createSimulation, type MockFacade } from '../../mock';
import { useGraphStore } from '../../stores/graph';
import { usePresenceStore } from '../../stores/presence';
import { connectStores } from '../../stores';
import type {
  ActorSummary, EntityDetail, EntitySummary, LiveWork, WorkspaceEvent,
} from '../../types/contract';
import {
  BlockedBadge, LiveBadges, PresenceAvatars, StalenessBadge, ToastViewport,
  TypingIndicator, WorkingAggregate, WorkingPulse, useToastStore,
} from '../../subsystems/live';
import { createFacade, renderWith, resetAll } from './helpers';

let facade: MockFacade;
let stop: (() => void) | null = null;
let eventSeq = 0;

function actorFrom(entity: EntitySummary): ActorSummary {
  return entity.createdBy;
}

/** An entity.upsert carrying a patched summary, always "newer" than the last. */
function upsert(entity: EntitySummary, patch: Partial<EntitySummary>): WorkspaceEvent {
  eventSeq += 1;
  return {
    type: 'entity.upsert',
    eventId: `evt_hand_${eventSeq}`,
    entity: {
      ...entity,
      ...patch,
      updatedAt: new Date(Date.now() + eventSeq * 1000).toISOString(),
    },
  };
}

function apply(event: WorkspaceEvent): void {
  act(() => { useGraphStore.getState().applyEvent(event); });
}

function liveWork(actor: ActorSummary, task: EntitySummary, minutesAgo = 12): LiveWork {
  return {
    actor,
    task: { ...task, badges: {} },
    startedAt: new Date(Date.now() - minutesAgo * 60_000).toISOString(),
    note: null,
  };
}

beforeEach(() => {
  resetAll();
  eventSeq = 0;
  facade = createFacade();
  stop?.();
  stop = connectStores(facade, facade.ids.space);
});

// -----------------------------------------------------------------------------
// presence + typing (store-fed only — DEV-4)
// -----------------------------------------------------------------------------

describe('presence and typing', () => {
  it('renders viewers-on-entity with overflow, then clears when they leave', async () => {
    const channel = await facade.getEntity(facade.ids.chBuild);
    const doc = await facade.getEntity(facade.ids.docSpec);
    const a = actorFrom(channel);
    const b = actorFrom(doc);

    renderWith(facade, <PresenceAvatars entityId={channel.id} max={1} />);
    expect(screen.queryByTestId('presence-avatars')).toBeNull();

    act(() => {
      usePresenceStore.getState().applyEvent({
        type: 'presence.changed', eventId: 'p1', entityId: channel.id,
        presence: { viewers: [a, b], typingActorIds: [], updatedAt: new Date().toISOString() },
      });
    });

    const stack = await screen.findByTestId('presence-avatars');
    expect(stack.textContent).toContain('+1');
    expect(stack.getAttribute('aria-label')).toContain(a.displayName);

    act(() => {
      usePresenceStore.getState().applyEvent({
        type: 'presence.changed', eventId: 'p2', entityId: channel.id,
        presence: { viewers: [], typingActorIds: [], updatedAt: new Date().toISOString() },
      });
    });
    await waitFor(() => expect(screen.queryByTestId('presence-avatars')).toBeNull());
  });

  it('names typists it knows and degrades gracefully for ones it does not', async () => {
    const channel = await facade.getEntity(facade.ids.chBuild);
    const mira = await facade.getEntity(facade.ids.mira);
    act(() => { useGraphStore.getState().ingestSummaries([mira]); });

    renderWith(facade, <TypingIndicator anchorId={channel.id} />);
    expect(screen.queryByTestId('typing-indicator')).toBeNull();

    act(() => {
      usePresenceStore.getState().applyEvent({
        type: 'typing.changed', eventId: 't1', anchorId: channel.id, typingActorIds: [mira.id],
      });
    });
    const typing = await screen.findByTestId('typing-indicator');
    expect(typing.textContent).toBe(`${mira.title} is typing…`);

    act(() => {
      usePresenceStore.getState().applyEvent({
        type: 'typing.changed', eventId: 't2', anchorId: channel.id, typingActorIds: ['ent_unknown'],
      });
    });
    await waitFor(() => expect(screen.getByTestId('typing-indicator').textContent).toBe('Someone is typing…'));
  });
});

// -----------------------------------------------------------------------------
// working pulse + aggregate
// -----------------------------------------------------------------------------

describe('agents at work', () => {
  it('pulses an actor chip and says what it is working on, since when', async () => {
    const task = await facade.getEntity(facade.ids.t104);
    const agent = await facade.getEntity(facade.ids.forge);
    const work = liveWork(
      { id: agent.id, kind: 'team_member', displayName: agent.title, isAgent: true },
      task,
    );

    renderWith(facade, <WorkingPulse work={work} />);
    const pulse = screen.getByTestId('working-pulse');
    expect(pulse.getAttribute('aria-label')).toMatch(
      new RegExp(`${agent.title} working on ${task.title.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')} since`),
    );
    expect(pulse.querySelector('.cv2-workpulse__dot')).not.toBeNull();
  });

  it('rolls a family up to “🤖 2 working” and reacts to the live badge', async () => {
    const task = await facade.getEntity(facade.ids.t104);
    const forge = await facade.getEntity(facade.ids.forge);
    const scout = await facade.getEntity(facade.ids.scout);
    const works = [
      liveWork({ id: forge.id, kind: 'team_member', displayName: forge.title, isAgent: true }, task),
      liveWork({ id: scout.id, kind: 'team_member', displayName: scout.title, isAgent: true }, task, 4),
    ];

    renderWith(facade, <WorkingAggregate entity={task} />);
    // The seed already has one agent on T-104; the badge must track the live count.
    const seeded = (task.badges.workingActors ?? []).length;
    if (seeded > 0) {
      expect(screen.getByTestId('working-aggregate').textContent).toContain(`${seeded} working`);
    } else {
      expect(screen.queryByTestId('working-aggregate')).toBeNull();
    }

    apply(upsert(task, { badges: { ...task.badges, workingActors: works } }));

    const agg = await screen.findByTestId('working-aggregate');
    await waitFor(() => expect(screen.getByTestId('working-aggregate').textContent).toContain('2 working'));
    expect(agg.textContent).toContain('🤖');

    apply(upsert(task, { badges: { ...task.badges, workingActors: [] } }));
    await waitFor(() => expect(screen.queryByTestId('working-aggregate')).toBeNull());
  });
});

// -----------------------------------------------------------------------------
// staleness + RE-PULL
// -----------------------------------------------------------------------------

describe('staleness', () => {
  async function docWithPull(): Promise<EntityDetail> {
    const doc = await facade.getEntity(facade.ids.docSpec);
    expect((doc.badges.pulls ?? []).length).toBeGreaterThan(0);
    return doc;
  }

  it('shows “vN pinned · vM → stale” the moment the content moves on', async () => {
    const doc = await docWithPull();
    const pull = (doc.badges.pulls ?? [])[0];

    renderWith(facade, <StalenessBadge entity={doc} facade={facade} />);
    // Before the bump the pin is current: at most the SOFTER "discussion moved"
    // signal shows — never the hard content-stale one.
    expect(screen.queryByTestId('staleness-badge')?.textContent ?? '').not.toMatch(/→ stale/);

    const simulation = createSimulation(facade);
    await act(async () => {
      for (let i = 0; i < 3; i += 1) await simulation.step(); // step 3 bumps the spec to v5
    });

    const badge = await screen.findByTestId('staleness-badge');
    expect(badge.textContent).toContain(`v${pull.pinnedVersion} pinned`);
    expect(badge.textContent).toMatch(/→ stale/);
  });

  it('one-click RE-PULL re-pins through the facade, clears the badge and toasts', async () => {
    const doc = await docWithPull();
    const pull = (doc.badges.pulls ?? [])[0];

    renderWith(facade, (
      <>
        <StalenessBadge entity={doc} facade={facade} />
        <ToastViewport />
      </>
    ));

    const simulation = createSimulation(facade);
    await act(async () => {
      for (let i = 0; i < 3; i += 1) await simulation.step();
    });
    await screen.findByTestId('staleness-badge');

    const button = screen.getByTestId(`repull-${pull.actor.id}`);
    await act(async () => { fireEvent.click(button); });

    await waitFor(() => expect(screen.queryByTestId('staleness-badge')).toBeNull());

    const after = await facade.getEntity(facade.ids.docSpec);
    const repulled = (after.badges.pulls ?? []).find((p) => p.actor.id === pull.actor.id);
    expect(repulled?.pinnedVersion).toBe(after.version);
    expect(repulled?.contentStale).toBe(false);

    expect(useToastStore.getState().toasts.some((t) => t.kind === 'stale')).toBe(true);
    await screen.findByTestId('toast-stale');
  });

  it('is read-only without a facade (no re-pull affordance to mis-fire)', async () => {
    const doc = await docWithPull();
    const stalePull = { ...(doc.badges.pulls ?? [])[0], contentStale: true };
    const staleDoc = { ...doc, version: doc.version + 1, badges: { ...doc.badges, pulls: [stalePull] } };

    renderWith(facade, <StalenessBadge entity={staleDoc} />);
    await screen.findByTestId('staleness-badge');
    expect(screen.queryByTestId(`repull-${stalePull.actor.id}`)).toBeNull();
  });
});

// -----------------------------------------------------------------------------
// blocked + the unblock moment
// -----------------------------------------------------------------------------

describe('blocked and the unblock moment', () => {
  it('shows the count and the waiting-on chips', async () => {
    const task = await facade.getEntity(facade.ids.t105);
    const blocked = task.badges.blocked;
    expect(blocked?.unresolvedHardDependencyCount).toBeGreaterThan(0);

    renderWith(facade, <BlockedBadge entity={task} />);
    const badge = await screen.findByTestId('blocked-badge');
    expect(badge.textContent).toContain(`blocked · ${blocked?.unresolvedHardDependencyCount}`);

    const waiting = screen.getByTestId('waiting-on');
    for (const w of (blocked?.waitingOn ?? []).slice(0, 3)) {
      expect(waiting.textContent).toContain(w.title.slice(0, 6));
    }
  });

  it('fires the unblock moment exactly once on the flip (never on mount)', async () => {
    const task = await facade.getEntity(facade.ids.t105);
    const onUnblocked = vi.fn();

    renderWith(facade, (
      <>
        <BlockedBadge entity={task} onUnblocked={onUnblocked} />
        <ToastViewport />
      </>
    ));
    await screen.findByTestId('blocked-badge');
    expect(onUnblocked).not.toHaveBeenCalled();

    apply(upsert(task, { badges: { ...task.badges, blocked: undefined } }));

    await waitFor(() => expect(onUnblocked).toHaveBeenCalledTimes(1));
    expect(screen.queryByTestId('blocked-badge')).toBeNull();
    await screen.findByTestId('unblock-moment');
    await screen.findByTestId('toast-unblock');
    expect(useToastStore.getState().toasts.at(-1)?.message).toContain(task.title);

    // A second, still-unblocked upsert must not re-fire the moment.
    apply(upsert(task, { badges: { ...task.badges, blocked: undefined } }));
    await waitFor(() => expect(onUnblocked).toHaveBeenCalledTimes(1));
  });

  it('the simulation’s completion ripple clears the badge on screen', async () => {
    const task = await facade.getEntity(facade.ids.t105);
    const onUnblocked = vi.fn();
    renderWith(facade, <BlockedBadge entity={task} onUnblocked={onUnblocked} />);
    await screen.findByTestId('blocked-badge');

    const simulation = createSimulation(facade);
    await act(async () => { await simulation.runAll(); });

    await waitFor(() => expect(screen.queryByTestId('blocked-badge')).toBeNull());
    expect(onUnblocked).toHaveBeenCalledTimes(1);
  });
});

// -----------------------------------------------------------------------------
// composed row
// -----------------------------------------------------------------------------

describe('LiveBadges composition', () => {
  it('stacks blocked → working → stale in one live row', async () => {
    const task = await facade.getEntity(facade.ids.t105);
    const forge = await facade.getEntity(facade.ids.forge);
    const work = liveWork({ id: forge.id, kind: 'team_member', displayName: forge.title, isAgent: true }, task);

    renderWith(facade, <LiveBadges entity={task} facade={facade} />);
    await screen.findByTestId('blocked-badge');

    apply(upsert(task, {
      version: task.version + 1,
      badges: {
        ...task.badges,
        workingActors: [work],
        pulls: [{
          actor: { id: forge.id, kind: 'team_member', displayName: forge.title, isAgent: true },
          localId: null, pinnedVersion: task.version, contentStale: true,
          discussionMoved: false, workStatus: 'working', pulledAt: new Date().toISOString(),
        }],
      },
    }));

    await screen.findByTestId('working-aggregate');
    await screen.findByTestId('staleness-badge');
    expect(screen.getByTestId('blocked-badge')).toBeTruthy();
  });
});
