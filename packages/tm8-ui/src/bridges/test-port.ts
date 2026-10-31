import { vi } from 'vitest';
import type { AttentionRequest, BridgeView, CommandResult, EdgeView, EntitySummary } from '@tm8/contract';
import { bridgeDeploys, bridgeInfra, bridgeRahul, channelDesign, chatLaunchPlan, memoryTokens } from '../fixtures/entities';
import { ada } from '../fixtures/actors';
import type { BridgesPort, PendingHandover } from './api';
import { pendingHandoverOf } from './api';
import { createFixtureBridgesClient, fixtureBridgeViewOf } from './fixture';

/** A port over the fixture client, with the seam reads stubbed: what the bridge tests drive. */
export function testPort(opts: { served?: readonly string[]; memories?: EdgeView[] } = {}) {
  const views = [bridgeInfra, bridgeDeploys, bridgeRahul].map((row) => fixtureBridgeViewOf(row)!);
  /* The attention items a hand-over raises and clears, as migration 411 does: what pendingHandovers reads. */
  const attention: AttentionRequest[] = [];
  const client = createFixtureBridgesClient(views, (id) => [chatLaunchPlan, channelDesign].find((t) => t.id === id), undefined, (event) => {
    const id = `att-${event.handover.id}`;
    if (event.type === 'offered') {
      attention.push({
        id, spaceId: event.handover.spaceId, entityId: event.handover.bridgeId, reason: event.reason, points: 50, status: 'open',
        version: 1, requestedBy: ada, acknowledgedBy: null, resolvedBy: null, resolutionNote: null,
        createdAt: event.handover.createdAt, updatedAt: event.handover.createdAt, acknowledgedAt: null, resolvedAt: null,
        assigneeId: ada.id,
      });
    } else {
      const row = attention.find((r) => r.id === id);
      if (row) row.status = 'cleared';
    }
  });
  const served = new Set(opts.served ?? []);
  const edges = [...(opts.memories ?? [])];
  const ok: CommandResult = { patches: [] } as unknown as CommandResult;
  const port = {
    ...client,
    list: vi.fn(client.list),
    pause: vi.fn(client.pause),
    resume: vi.fn(client.resume),
    remove: vi.fn(client.remove),
    update: vi.fn(client.update),
    retarget: vi.fn(client.retarget),
    targets: vi.fn(async (): Promise<EntitySummary[]> => [chatLaunchPlan]),
    memories: vi.fn(async () => edges),
    memoryCandidates: vi.fn(async (): Promise<EntitySummary[]> => [memoryTokens]),
    linkMemory: vi.fn(async (_bridgeId: string, memoryId: string) => {
      edges.push(memoryEdge('edge-new', memoryId === memoryTokens.id ? memoryTokens : memoryTokens));
      return ok;
    }),
    unlinkMemory: vi.fn(async (edgeId: string) => {
      edges.splice(edges.findIndex((e) => e.id === edgeId), 1);
      return ok;
    }),
    serves: (op: string) => served.has(op),
    pendingHandovers: vi.fn(async (_spaceId: string, bridgeId: string): Promise<PendingHandover[]> =>
      attention.filter((r) => r.entityId === bridgeId).flatMap((r) => pendingHandoverOf(r) ?? [])),
    handover: {
      offer: vi.fn(client.handover.offer),
      accept: vi.fn(client.handover.accept),
      decline: vi.fn(client.handover.decline),
      withdraw: vi.fn(client.handover.withdraw),
    },
  } satisfies BridgesPort;
  return { port, client, views, attention };
}

export function memoryEdge(id: string, memory: EntitySummary): EdgeView {
  return {
    id, type: 'remembers', source: bridgeInfra, target: memory, props: {},
    createdBy: ada, createdAt: '2026-07-28T09:15:00.000Z', updatedAt: '2026-07-28T09:15:00.000Z',
  };
}

export type TestBridge = BridgeView;
