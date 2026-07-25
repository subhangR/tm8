/**
 * WorkspaceEvent conformance — the HTTP-portable core of the UI foundation
 * `reconciliation` and `stores-replay` suites, updated for the AM-2 §3
 * envelope: every event carries {spaceId, seq, occurredAt, schemaVersion},
 * `seq` is per-space monotonic (the dedupe/ordering key and the poll `since`
 * cursor basis), and `clientMutationId` threads through EVERY mutation-derived
 * event for optimistic reconciliation (DEV-9). There are no bare-entity-id
 * variants — each event carries its full typed payload.
 *
 * The WS transport itself (events.subscribe) is exercised at M1+ — the poll
 * fallback returns the same events from the retained buffer (04 §2.3).
 */
import { beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { WorkspaceEventSchema, WORKSPACE_EVENT_SCHEMA_VERSION, type WorkspaceEvent } from '@tm8/contract';
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

describe('workspace events (04 §2, DEV-4/9, AM-2 §3)', () => {
  it('every event carries the envelope: right spaceId, monotonic seq, current schemaVersion', async () => {
    const { events } = await pollEvents();
    expect(events.length).toBeGreaterThan(0);
    for (const e of events) {
      expect(e.spaceId, 'space-scoped feed must only carry this space').toBe(w.spaceId);
      expect(e.schemaVersion).toBe(WORKSPACE_EVENT_SCHEMA_VERSION);
    }
    const seqs = events.map((e) => e.seq);
    expect(new Set(seqs).size, 'seq is the per-space dedupe key — no duplicates').toBe(seqs.length);
    const sorted = [...seqs].sort((a, b) => a - b);
    expect(seqs, 'poll must return events in seq order').toEqual(sorted);
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

  it('message events are mutation-derived too — they carry clientMutationId (AM-2 §3)', async () => {
    const cmid = `cmid-msg-${randomUUID()}`;
    await api.command('messages.post', { anchorId: w.t101, body: 'envelope probe', clientMutationId: cmid });
    const { events } = await pollEvents();
    const mine = events.find((e) =>
      e.type === 'message.created' && 'clientMutationId' in e && e.clientMutationId === cmid);
    expect(mine, 'message.created must carry the originating clientMutationId').toBeDefined();
  });

  it('an idempotent replay does not emit a second event (DEV-9 × AM-2 §3)', async () => {
    const cmid = `cmid-replay-${randomUUID()}`;
    const input = { spaceId: w.spaceId, kind: 'task', title: 'Replay probe', parentId: w.epic, clientMutationId: cmid };
    await api.command('entities.create', input);
    await api.command('entities.create', input); // ledger replay, no-op
    const { events } = await pollEvents();
    const mine = events.filter((e) => 'clientMutationId' in e && e.clientMutationId === cmid && e.type === 'entity.upsert');
    expect(mine, 'replayed command must not re-emit its event').toHaveLength(1);
  });

  it('the durable feed never carries presence/typing (DEV-4)', async () => {
    const { events } = await pollEvents();
    expect(events.every((e) => e.type !== 'presence.changed' && e.type !== 'typing.changed')).toBe(true);
  });

  it('since-cursor catch-up returns only events with a later seq', async () => {
    const first = await pollEvents();
    const maxSeq = Math.max(...first.events.map((e) => e.seq));
    const marker = first.page.nextCursor;
    const cmid = `cmid-evt2-${randomUUID()}`;
    await api.command('messages.post', { anchorId: w.t101, body: 'after the marker', clientMutationId: cmid });
    const later = await pollEvents(marker ? { since: marker } : {});
    if (marker) {
      expect(later.events.every((e) => e.seq > maxSeq), 'since-cursor must exclude already-seen seqs').toBe(true);
    }
    expect(later.events.some((e) => e.type === 'message.created')).toBe(true);
  });
});
