import { describe, expect, it } from "vitest";
import { startW3PublicServer, successData } from "../public-harness.js";
import { observeG03DatabaseOutcome } from "../agentic-observer.js";

describe("W3.G03 clean-room public protocol retest", () => {
  // TIMEOUT, not a knob: this case builds its own world inside the test body.
  // `startW3PublicServer` creates a scratch database, applies every migration,
  // and bootstraps a real production server — measured at ~4.5s on this box
  // BEFORE the first assertion runs. Vitest's default `testTimeout` is 5000ms
  // and this package ships no vitest config, so the default applies: the case
  // had under 500ms for its actual work and died on the clock, not on a
  // failed expectation. The siblings that stay green (g03-agentic, g06, g07,
  // g15) do the same startup in `beforeAll`, which is governed by the separate
  // 10s `hookTimeout` — that is the only reason they never hit this. Raising
  // the budget changes no assertion; every check below still has to pass.
  it("creates, replays, deletes, and normalizes a public dependency workflow", async () => {
    expect(process.env.TM8_W3_API_BEARER_TOKEN).toBeUndefined();
    const harness = await startW3PublicServer("agentic_g03_retest");
    try {
      const spaceResponse = await harness.request("POST", "/v2/spaces", {
        name: "G03 agentic public retest space",
        clientMutationId: "agentic-g03-retest-space-create",
      });
      const spaceData = successData(spaceResponse) as { space: { id: string } };
      const entityResponse = await harness.request("POST", "/v2/entities", {
        clientMutationId: "agentic-g03-retest-first-task-create",
        spaceId: spaceData.space.id,
        kind: "task",
        title: "G03 agentic first task",
      });
      const entityData = successData(entityResponse) as { entity: { id: string } };
      const edgeTypes = successData(await harness.request("GET", "/v2/edge-types")) as Array<{
        type: string;
        sourceKinds: string[];
        destinationKinds: string[];
        acyclic: boolean;
      }>;
      const dependency = edgeTypes.find((edgeType) => edgeType.type === "depends_on");
      expect(dependency).toMatchObject({ acyclic: true });
      const secondEntityData = successData(await harness.request("POST", "/v2/entities", {
        clientMutationId: "agentic-g03-retest-second-task-create",
        spaceId: spaceData.space.id,
        kind: "task",
        title: "G03 agentic second task",
      })) as { entity: { id: string } };
      const edgeInput = {
        srcId: secondEntityData.entity.id,
        dstId: entityData.entity.id,
        type: "depends_on",
      };
      const forgedServerOrigin = await harness.request("POST", "/v2/edges", {
        ...edgeInput,
        origin: "Server",
      });
      expect(forgedServerOrigin).toMatchObject({
        status: 400,
        body: {
          error: {
            code: "invalid_input",
            details: { issues: [{ keys: ["origin"] }] },
          },
        },
      });
      const edgeData = successData(await harness.request("POST", "/v2/edges", edgeInput)) as { edge: { id: string } };
      const replayData = successData(await harness.request("POST", "/v2/edges", edgeInput)) as { edge: { id: string } };
      expect(replayData.edge.id).toBe(edgeData.edge.id);
      const edgeList = successData(await harness.request("GET", "/v2/edges")) as {
        items: Array<{ id: string }>;
        nextCursor: string | null;
      };
      expect(edgeList.items.some((edge) => edge.id === edgeData.edge.id)).toBe(true);
      const deleteResponse = await harness.request("DELETE", `/v2/edges/${edgeData.edge.id}`, {
        clientMutationId: "agentic-g03-retest-edge-delete",
      });
      const deleteData = successData(deleteResponse);
      expect(deleteData).toMatchObject({ patches: expect.any(Array) });
      const afterDeleteList = successData(await harness.request("GET", "/v2/edges")) as {
        items: Array<{ id: string }>;
      };
      expect(afterDeleteList.items.some((edge) => edge.id === edgeData.edge.id)).toBe(false);
      const placementData = successData(await harness.request("POST", "/v2/placements", {
        sourceId: secondEntityData.entity.id,
        targetId: entityData.entity.id,
        intent: "depend",
      })) as { edge: { id: string; type: string; source: { id: string }; target: { id: string }; hard: boolean } };
      expect(placementData.edge).toMatchObject({
        type: "depends_on",
        source: { id: entityData.entity.id },
        target: { id: secondEntityData.entity.id },
        hard: true,
      });
      const normalizedList = successData(await harness.request("GET", "/v2/edges")) as {
        items: Array<{ id: string; type: string; source: { id: string }; target: { id: string }; hard: boolean }>;
      };
      expect(normalizedList.items.find((edge) => edge.id === placementData.edge.id)).toMatchObject({
        type: "depends_on",
        source: { id: entityData.entity.id },
        target: { id: secondEntityData.entity.id },
        hard: true,
      });
      const databaseOutcome = await observeG03DatabaseOutcome(
        harness,
        [entityData.entity.id, secondEntityData.entity.id],
        [
          "agentic-g03-retest-space-create",
          "agentic-g03-retest-first-task-create",
          "agentic-g03-retest-second-task-create",
          "agentic-g03-retest-edge-delete",
        ],
      );
      expect(databaseOutcome.edges).toEqual([
        {
          id: placementData.edge.id,
          sourceId: entityData.entity.id,
          targetId: secondEntityData.entity.id,
          type: "depends_on",
          props: { hard: true },
        },
      ]);
      expect(databaseOutcome.mutations).toHaveLength(4);
      expect(databaseOutcome.mutations).toEqual(expect.arrayContaining([
        { clientMutationId: "agentic-g03-retest-space-create", operation: "spaces.create" },
        { clientMutationId: "agentic-g03-retest-first-task-create", operation: "entities.create" },
        { clientMutationId: "agentic-g03-retest-second-task-create", operation: "entities.create" },
        { clientMutationId: "agentic-g03-retest-edge-delete", operation: "edges.delete" },
      ]));
    } finally {
      await harness.close();
    }
  }, 120_000);
});
