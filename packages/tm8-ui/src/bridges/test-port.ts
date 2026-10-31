import { vi } from 'vitest';
import type { BridgeView, CommandResult, CreateInviteInput, EdgeView, EntitySummary, SpaceInviteView } from '@tm8/contract';
import { bridgeDeploys, bridgeInfra, bridgeRahul, chatLaunchPlan, memoryTokens } from '../fixtures/entities';
import { ada } from '../fixtures/actors';
import type { BridgesPort } from './api';
import { createFixtureBridgesClient, fixtureBridgeViewOf } from './fixture';
import { fixturePort } from './people/fixtures';

/** A port over the fixture client, with the seam reads stubbed: what the bridge tests drive. */
export function testPort(opts: { served?: readonly string[]; memories?: EdgeView[]; people?: boolean } = {}) {
  const views = [bridgeInfra, bridgeDeploys, bridgeRahul].map((row) => fixtureBridgeViewOf(row)!);
  const client = createFixtureBridgesClient(views);
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
    // Lane P's roster and B3's invite door, only when a test asks for them.
    ...(opts.people ? {
      people: fixturePort(),
      createInvite: vi.fn(async (spaceId: string, input: CreateInviteInput) => ({
        id: 'inv-1', spaceId, code: 'JOIN-1234', role: input.role ?? 'member', maxUses: 1, useCount: 0,
        expiresAt: null, revokedAt: null, createdAt: '2026-10-31T09:00:00.000Z',
      }) as unknown as SpaceInviteView),
    } : {}),
  } satisfies BridgesPort;
  return { port, client, views };
}

export function memoryEdge(id: string, memory: EntitySummary): EdgeView {
  return {
    id, type: 'remembers', source: bridgeInfra, target: memory, props: {},
    createdBy: ada, createdAt: '2026-07-28T09:15:00.000Z', updatedAt: '2026-07-28T09:15:00.000Z',
  };
}

export type TestBridge = BridgeView;
