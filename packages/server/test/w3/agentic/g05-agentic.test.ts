import { describe, expect, it } from "vitest";

import { startW3PublicServer, successData } from "../public-harness.js";
import { observeG05DatabaseOutcome } from "../agentic-observer.js";

describe("W3 G05 agentic public discovery workflow", () => {
  it("discovers and runs a collection, graph, and undo workflow", async () => {
    const harness = await startW3PublicServer("agentic_g05");

    try {
      const response = await harness.request("POST", "/v2/spaces", {
        name: "Agentic G05 discovery space",
        clientMutationId: "agentic-g05-space-1",
      });
      const data = successData(response);
      const space = data.space;

      const createTask = async (title: string, clientMutationId: string) =>
        successData(
          await harness.request("POST", "/v2/entities", {
            spaceId: space.id,
            title,
            kind: "task",
            clientMutationId,
          }),
        ).entity;

      const taskOne = await createTask("Agentic G05 task one", "agentic-g05-entity-1");
      const taskTwo = await createTask("Agentic G05 task two", "agentic-g05-entity-2");
      const taskThree = await createTask("Agentic G05 task three", "agentic-g05-entity-3");

      const collectionResponse = await harness.request("POST", "/v2/collections/query", {
        spaceId: space.id,
        limit: 2,
      });
      const collection = successData(collectionResponse);
      expect(collection.page.items).toHaveLength(2);
      expect(collection.page.nextCursor).toEqual(expect.any(String));

      const secondCollection = successData(
        await harness.request("POST", "/v2/collections/query", {
          spaceId: space.id,
          limit: 2,
          cursor: collection.page.nextCursor,
        }),
      );
      expect(secondCollection.page.items.length).toBeGreaterThan(0);
      expect(new Set([...collection.page.items, ...secondCollection.page.items].map((item) => item.id)).size).toBeGreaterThan(
        collection.page.items.length,
      );

      const malformedCursor = await harness.request("POST", "/v2/collections/query", {
        spaceId: space.id,
        limit: 2,
        cursor: "not-a-valid-cursor",
      });
      expect(malformedCursor.status).toBe(400);
      expect(malformedCursor.body).toMatchObject({ error: { code: "invalid_cursor" } });

      const firstEdgeResponse = await harness.request("POST", "/v2/edges", {
        srcId: taskOne.id,
        dstId: taskTwo.id,
        type: "depends_on",
        clientMutationId: "agentic-g05-edge-1",
      });
      const firstEdge = successData(firstEdgeResponse);
      expect(firstEdge.edge.source.id).toBe(taskOne.id);
      expect(firstEdge.edge.target.id).toBe(taskTwo.id);
      expect(firstEdge.undo.token).toEqual(expect.any(String));

      const secondEdge = successData(
        await harness.request("POST", "/v2/edges", {
          srcId: taskTwo.id,
          dstId: taskThree.id,
          type: "depends_on",
          clientMutationId: "agentic-g05-edge-2",
        }),
      );
      expect(secondEdge.edge.source.id).toBe(taskTwo.id);
      expect(secondEdge.edge.target.id).toBe(taskThree.id);

      const graphResponse = await harness.request("POST", "/v2/graph/query", {
        spaceId: space.id,
      });
      const graph = successData(graphResponse);
      expect(graph.nodes.map((node) => node.id)).toEqual(
        expect.arrayContaining([taskOne.id, taskTwo.id, taskThree.id]),
      );
      expect(graph.edges.map((edge) => edge.id)).toEqual(
        expect.arrayContaining([firstEdge.edge.id, secondEdge.edge.id]),
      );

      const undoResponse = await harness.request("POST", "/v2/undo", {
        token: firstEdge.undo.token,
        clientMutationId: "agentic-g05-undo-1",
      });
      const undo = successData(undoResponse);
      expect(undo.patches.length).toBeGreaterThan(0);

      const replay = await harness.request("POST", "/v2/undo", {
        token: firstEdge.undo.token,
        clientMutationId: "agentic-g05-undo-replay",
      });
      expect(replay.status).toBe(409);
      expect(replay.body).toMatchObject({
        error: { code: "invariant_violation", message: "undo token already redeemed" },
      });

      const databaseOutcome = await observeG05DatabaseOutcome(
        harness,
        space.id,
        [firstEdge.edge.id, secondEdge.edge.id],
        firstEdge.undo.token,
        [
          "agentic-g05-entity-1",
          "agentic-g05-entity-2",
          "agentic-g05-entity-3",
          "agentic-g05-edge-1",
          "agentic-g05-edge-2",
          "agentic-g05-undo-1",
          "agentic-g05-undo-replay",
        ],
      );
      expect(databaseOutcome.taskCount).toBe(3);
      expect(databaseOutcome.liveEdgeIds).toEqual([secondEdge.edge.id]);
      expect(databaseOutcome.undo).toEqual({
        token: firstEdge.undo.token,
        exists: true,
        redemptionClientMutationId: "agentic-g05-undo-1",
      });
      expect(databaseOutcome.mutations).toHaveLength(6);
      expect(databaseOutcome.mutations).toEqual(
        expect.arrayContaining([
          { clientMutationId: "agentic-g05-edge-1", operation: "edges.create" },
          { clientMutationId: "agentic-g05-edge-2", operation: "edges.create" },
          { clientMutationId: "agentic-g05-entity-1", operation: "entities.create" },
          { clientMutationId: "agentic-g05-entity-2", operation: "entities.create" },
          { clientMutationId: "agentic-g05-entity-3", operation: "entities.create" },
          { clientMutationId: "agentic-g05-undo-1", operation: "commands.undo" },
        ]),
      );

      console.log(
        "G05 public workflow evidence",
        JSON.stringify({
          baseUrl: harness.baseUrl,
          taskIds: [taskOne.id, taskTwo.id, taskThree.id],
          collectionPageSizes: [collection.page.items.length, secondCollection.page.items.length],
          graph: { nodeCount: graph.nodes.length, edgeIds: graph.edges.map((edge) => edge.id) },
          undo: { token: firstEdge.undo.token, replayStatus: replay.status },
          databaseOutcome,
        }),
      );
    } finally {
      await harness.close();
    }
  });
});
