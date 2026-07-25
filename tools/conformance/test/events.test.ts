/**
 * WorkspaceEvent conformance — the HTTP-portable core of the UI foundation
 * `reconciliation` and `stores-replay` suites: mutations surface as canonical
 * WorkspaceEvents (04 §2), events carry the originating `clientMutationId`
 * for optimistic reconciliation (DEV-9), eventIds are unique for client-side
 * dedupe, and the polling catch-up endpoint honors `since` cursors.
 *
 * The WS transport itself (events.subscribe) is exercised at M1+ — the poll
 * fallback returns the same events from the retained buffer (04 §2.3).
 */
import { beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { WorkspaceEventSchema, type WorkspaceEvent } from '@tm8/contract';
import { api } from '../src/client.js';
import { buildWorld, expectValid, type World } from '../src/world.js';

let w: World;

beforeAll(async () => {
  w = await buildWorld('events');
});

type EventPage = { items: unknown[]; nextCursor: string | null };

async function pollEvents(query: Record<string, string> = {}): Promise<{ events: WorkspaceEvent[]; page: EventPage }> {
  const page = await api.read('events.poll', { spaceId: w.spaceId }, query) as EventPage;
  const events = page.items.map((e, i) => expectValid(WorkspaceEventSchema, e, `event[${i}]`));
  return { events, page };
}

describe('workspace events (04 §2, DEV-4/9)', () => {
  it('the world build surfaced entity.upsert events; all events are contract-shaped with unique eventIds', async () => {
    const { events } = await pollEvents();
    expect(events.length).toBeGreaterThan(0);
    const ids = events.map((e) => e.eventId);
    expect(new Set(ids).size).toBe(ids.length);
    expect(events.some((e) => e.type === 'entity.upsert')).toBe(true);
  });

  it('mutations thread clientMutationId into their events (optimistic reconciliation)', async () => {
    const cmid = `cmid-evt-${randomUUID()}`;
    await api.command('entities.create', {
      spaceId: w.spaceId, kind: 'task', title: 'Event probe', parentId: w.epic, clientMutationId: cmid,
    });
    const { events } = await pollEvents();
    const mine = events.find((e) =>
      (e.type === 'entity.upsert' || e.type === 'edge.upsert') &&
      'clientMutationId' in e && e.clientMutationId === cmid);
    expect(mine, 'entity.upsert must carry the originating clientMutationId').toBeDefined();
  });

  it('the durable feed never carries presence/typing (DEV-4)', async () => {
    const { events } = await pollEvents();
    expect(events.every((e) => e.type !== 'presence.changed' && e.type !== 'typing.changed')).toBe(true);
  });

  it('since-cursor catch-up returns only later events', async () => {
    const first = await pollEvents();
    const marker = first.page.nextCursor;
    const cmid = `cmid-evt2-${randomUUID()}`;
    await api.command('messages.post', { anchorId: w.t101, body: 'after the marker', clientMutationId: cmid });
    const later = await pollEvents(marker ? { since: marker } : {});
    const earlierIds = new Set(first.events.map((e) => e.eventId));
    if (marker) {
      expect(later.events.every((e) => !earlierIds.has(e.eventId)), 'since-cursor must exclude already-seen events').toBe(true);
    }
    expect(later.events.some((e) => e.type === 'message.created')).toBe(true);
  });
});
