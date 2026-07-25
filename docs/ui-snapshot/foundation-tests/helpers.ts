/**
 * Foundation test helpers: a manual clock + a deterministic seeded facade
 * (latency 0) + an event recorder.
 */
import { createSeededWorld, MockFacade } from '../../mock';
import type { PresenceWorkspaceEvent, WorkspaceEvent } from '../../types/contract';

export class ManualClock {
  private t: number;
  constructor(startIso = '2026-07-25T12:00:00.000Z') { this.t = Date.parse(startIso); }
  now = (): number => this.t;
  advance(ms: number): void { this.t += ms; }
  advanceMinutes(min: number): void { this.advance(min * 60_000); }
}

export interface TestRig {
  facade: MockFacade;
  clock: ManualClock;
  /** Durable stream only (DEV-4) — never carries presence/typing. */
  events: WorkspaceEvent[];
  /** Client-synthesized presence channel (subscribePresence). */
  presenceEvents: PresenceWorkspaceEvent[];
  ids: MockFacade['ids'];
}

export function createRig(): TestRig {
  const clock = new ManualClock();
  const facade = new MockFacade(createSeededWorld(clock.now), { latency: 0 });
  const events: WorkspaceEvent[] = [];
  const presenceEvents: PresenceWorkspaceEvent[] = [];
  facade.subscribe(facade.ids.space, (e) => events.push(e));
  facade.subscribePresence(facade.ids.space, (e) => presenceEvents.push(e));
  return { facade, clock, events, presenceEvents, ids: facade.ids };
}

export const ISO_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
