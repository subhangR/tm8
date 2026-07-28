import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startW3PublicServer, successData } from "../public-harness.js";
import { observeG03DatabaseOutcome } from "../agentic-observer.js";

/**
 * G03 agentic verification.
 *
 * Discovery path (packages/server, executed via the evaluator adapter, not read as source):
 *   bun test/w3/discovery-adapter.ts root
 *     -> nouns: edge(4) edge-type(1) entity(20) placement(1) space(22) ...
 *   bun test/w3/discovery-adapter.ts noun space [+ cursor]
 *   bun test/w3/discovery-adapter.ts noun entity [+ cursor]
 *   bun test/w3/discovery-adapter.ts noun edge
 *   bun test/w3/discovery-adapter.ts noun edge-type
 *   bun test/w3/discovery-adapter.ts noun placement
 *   bun test/w3/discovery-adapter.ts operation spaces.create
 *   bun test/w3/discovery-adapter.ts operation entities.create
 *   bun test/w3/discovery-adapter.ts operation edgeTypes.list
 *   bun test/w3/discovery-adapter.ts operation edges.create
 *   bun test/w3/discovery-adapter.ts operation edges.list
 *   bun test/w3/discovery-adapter.ts operation edges.patch
 *   bun test/w3/discovery-adapter.ts operation edges.delete
 *   bun test/w3/discovery-adapter.ts operation placements.apply
 * catalogDigest observed at every call: sha256:df96ff5a4c2d11e41ec1d7b9c5e460bdcb8ae8d9c2c99b140f59e08305f8d604
 *
 * Request field names (srcId/dstId/type/clientMutationId for edges.create, sourceId/targetId/intent
 * for placements.apply, props for edges.patch) were learned from live 400 "invalid_input" validation
 * responses returned by the real production HTTP Server, not from source.
 */

describe("W3.G03 agentic: discover, create, relate, and place two tasks", () => {
  let harness: Awaited<ReturnType<typeof startW3PublicServer>>;
  let spaceId: string;
  let taskAId: string;
  let taskBId: string;
  let edgeId: string;

  beforeAll(async () => {
    harness = await startW3PublicServer("agentic_g03");

    const spaceRes = await harness.request("POST", "/v2/spaces", {
      name: "G03 Agentic Space",
      clientMutationId: "g03-agentic-space",
    });
    expect(spaceRes.status).toBe(201);
    spaceId = successData(spaceRes).space.id;

    const taskARes = await harness.request("POST", "/v2/entities", {
      spaceId,
      kind: "task",
      title: "G03 Agentic Task A",
      clientMutationId: "g03-agentic-task-a",
    });
    expect(taskARes.status).toBe(201);
    taskAId = successData(taskARes).entity.id;

    const taskBRes = await harness.request("POST", "/v2/entities", {
      spaceId,
      kind: "task",
      title: "G03 Agentic Task B",
      clientMutationId: "g03-agentic-task-b",
    });
    expect(taskBRes.status).toBe(201);
    taskBId = successData(taskBRes).entity.id;
  });

  afterAll(async () => {
    await harness.close();
  });

  it("lists available edge types through the real production Server", async () => {
    const res = await harness.request("GET", "/v2/edge-types");
    expect(res.status).toBe(200);
    const types: Array<{ type: string; sourceKinds: string[]; destinationKinds: string[] }> = successData(res);
    const dependsOn = types.find((t) => t.type === "depends_on");
    expect(dependsOn).toBeDefined();
    expect(dependsOn!.sourceKinds).toContain("*");
    expect(dependsOn!.destinationKinds).toContain("*");
  });

  it("creates a depends_on edge between the two tasks, replaying the same clientMutationId idempotently", async () => {
    const createBody = {
      srcId: taskAId,
      dstId: taskBId,
      type: "depends_on",
      clientMutationId: "g03-agentic-edge-1",
    };

    const firstRes = await harness.request("POST", "/v2/edges", createBody);
    expect(firstRes.status).toBe(201);
    const firstEdge = successData(firstRes).edge;
    expect(firstEdge.type).toBe("depends_on");
    edgeId = firstEdge.id;

    // Replay: same clientMutationId, same body -> idempotent, no duplicate edge.
    const replayRes = await harness.request("POST", "/v2/edges", createBody);
    expect(replayRes.status).toBe(201);
    const replayEdge = successData(replayRes).edge;
    expect(replayEdge.id).toBe(edgeId);
  });

  it("reads the edge back through a filtered list", async () => {
    const res = await harness.request("GET", `/v2/edges?entityId=${taskAId}`);
    expect(res.status).toBe(200);
    const items: Array<{ id: string }> = successData(res).items;
    expect(items.map((i) => i.id)).toContain(edgeId);
  });

  it("modifies client-owned edge props", async () => {
    const res = await harness.request("PATCH", `/v2/edges/${edgeId}`, {
      props: { hard: false },
      clientMutationId: "g03-agentic-edge-patch-1",
    });
    expect(res.status).toBe(200);
    expect(successData(res).edge.props.hard).toBe(false);
  });

  it("rejects a client attempt to own the Server-owned origin field", async () => {
    const res = await harness.request("PATCH", `/v2/edges/${edgeId}`, {
      props: { origin: "client-forged-origin" },
      clientMutationId: "g03-agentic-edge-patch-origin",
    });
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe("forbidden");
    expect(String(res.body.error.message)).toMatch(/origin/i);
  });

  it("deletes the edge and confirms it is gone from the filtered list", async () => {
    const res = await harness.request("DELETE", `/v2/edges/${edgeId}`, {
      clientMutationId: "g03-agentic-edge-delete-1",
    });
    expect(res.status).toBe(200);

    const listRes = await harness.request("GET", `/v2/edges?entityId=${taskAId}`);
    const items: Array<{ id: string }> = successData(listRes).items;
    expect(items.map((i) => i.id)).not.toContain(edgeId);
  });

  it("applies a placement intent that produces a durable normalized depends_on relationship, verified against bounded DB facts", async () => {
    const placementRes = await harness.request("POST", "/v2/placements", {
      sourceId: taskAId,
      targetId: taskBId,
      intent: "depend",
      clientMutationId: "g03-agentic-placement-1",
    });
    expect(placementRes.status).toBe(200);
    const placedEdge = successData(placementRes).edge;
    expect(placedEdge.type).toBe("depends_on");
    expect([placedEdge.source.id, placedEdge.target.id].sort()).toEqual([taskAId, taskBId].sort());

    const outcome = await observeG03DatabaseOutcome(
      harness,
      [placedEdge.id, taskAId, taskBId],
      ["g03-agentic-placement-1"],
    );

    const dbEdge = outcome.edges.find((e: { id: string }) => e.id === placedEdge.id);
    expect(dbEdge).toBeDefined();
    expect(dbEdge!.type).toBe("depends_on");
    expect([dbEdge!.sourceId, dbEdge!.targetId].sort()).toEqual([taskAId, taskBId].sort());

    const mutationLabels = outcome.mutations.map((m: { clientMutationId: string; operation: string }) => m.operation);
    expect(mutationLabels).toContain("placements.apply");
  });
});
