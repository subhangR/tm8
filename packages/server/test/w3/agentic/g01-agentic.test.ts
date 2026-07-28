import { describe, expect, it } from "vitest";

import { observeG01DatabaseOutcome } from "../agentic-observer.js";
import { startW3PublicServer, successData } from "../public-harness.js";

type Space = {
  id: string;
  name: string;
  description: string;
};

type CreateSpaceResult = {
  space: Space;
  memberId: string;
  defaultChannelId: string;
};

type TaskAxis = {
  id: string;
  name: string;
  axisValues: string[];
  kind: string;
  position: number;
};

type G01DatabaseOutcome = {
  space: Space & { exists: boolean; settingsRevision: number };
  memberCount: number;
  channelCount: number;
  manualTaskAxisCount: number;
  inviteCount: number;
  mutations: Array<{ clientMutationId: string; operation: string }>;
};

describe("W3.G01 agentic discovery workflow", () => {
  it("uses only discovered public operations for identity, Space, and task-axis work", async () => {
    const harness = await startW3PublicServer("agentic_g01");
    console.info(`G01 production public URL: ${harness.baseUrl}`);
    const suffix = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const createMutationId = `agentic-g01-create-${suffix}`;
    const updateMutationId = `agentic-g01-update-${suffix}`;
    const axisMutationId = `agentic-g01-axis-${suffix}`;

    try {
      const identity = await harness.request("GET", "/v2/identity");
      const caller = successData(identity) as { identityId: string; isOwner: boolean };
      expect(identity.status).toBe(200);
      expect(caller.identityId).toBeTruthy();
      expect(caller.isOwner).toBe(true);

      const create = await harness.request("POST", "/v2/spaces", {
        name: `G01 Space ${suffix}`,
        clientMutationId: createMutationId,
      });
      const created = successData(create) as CreateSpaceResult;
      expect(create.status).toBe(201);
      expect(created.space).toMatchObject({
        id: expect.any(String),
        name: `G01 Space ${suffix}`,
        description: "",
      });
      expect(created.memberId).toBeTruthy();
      expect(created.defaultChannelId).toBeTruthy();

      const replay = await harness.request("POST", "/v2/spaces", {
        name: `G01 Space ${suffix}`,
        clientMutationId: createMutationId,
      });
      const replayed = successData(replay) as CreateSpaceResult;
      expect(replay.status).toBe(201);
      expect(replayed).toEqual(created);

      const updatedDescription = `G01 updated ${suffix}`;
      const update = await harness.request("PATCH", `/v2/spaces/${created.space.id}`, {
        description: updatedDescription,
        clientMutationId: updateMutationId,
      });
      const updated = successData(update) as Space;
      expect(update.status).toBe(200);
      expect(updated).toMatchObject({ id: created.space.id, description: updatedDescription });

      const invalidAxis = await harness.request("POST", `/v2/spaces/${created.space.id}/task-axes`, {});
      expect(invalidAxis.status).toBe(400);
      expect(invalidAxis.body).toMatchObject({
        error: { code: "invalid_input", retryable: false },
      });

      const axis = await harness.request("POST", `/v2/spaces/${created.space.id}/task-axes`, {
        name: "G01 workflow stage",
        axisValues: ["queued", "done"],
        kind: "manual",
        position: 0,
        clientMutationId: axisMutationId,
      });
      const createdAxis = successData(axis) as TaskAxis;
      expect(axis.status).toBe(201);
      expect(createdAxis).toMatchObject({
        id: expect.any(String),
        name: "G01 workflow stage",
        axisValues: ["queued", "done"],
        kind: "manual",
        position: 0,
      });

      const space = await harness.request("GET", `/v2/spaces/${created.space.id}`);
      const settings = await harness.request("GET", `/v2/spaces/${created.space.id}/settings`);
      const axes = await harness.request("GET", `/v2/spaces/${created.space.id}/task-axes`);
      const readbackSpace = successData(space) as Space;
      const readbackSettings = successData(settings) as {
        space: Space;
        taskAxes: TaskAxis[];
        settingsRevision: number;
      };
      const readbackAxes = successData(axes) as TaskAxis[];
      expect(space.status).toBe(200);
      expect(settings.status).toBe(200);
      expect(axes.status).toBe(200);
      expect(readbackSpace).toMatchObject({ id: created.space.id, description: updatedDescription });
      expect(readbackSettings.space).toMatchObject({ id: created.space.id, description: updatedDescription });
      expect(readbackSettings.settingsRevision).toBeGreaterThan(0);
      expect(readbackSettings.taskAxes).toEqual(expect.arrayContaining([createdAxis]));
      expect(readbackAxes).toEqual(expect.arrayContaining([createdAxis]));

      const database = (await observeG01DatabaseOutcome(harness, created.space.id, [
        createMutationId,
        updateMutationId,
        axisMutationId,
      ])) as G01DatabaseOutcome;
      expect(database.space).toMatchObject({
        id: created.space.id,
        exists: true,
        name: created.space.name,
        description: updatedDescription,
      });
      expect(database.space.settingsRevision).toBeGreaterThan(0);
      expect(database).toMatchObject({
        memberCount: 1,
        channelCount: 1,
        manualTaskAxisCount: 1,
        inviteCount: 0,
      });
      expect(database.mutations).toEqual(
        expect.arrayContaining([
          { clientMutationId: createMutationId, operation: "spaces.create" },
          { clientMutationId: updateMutationId, operation: "spaces.update" },
          { clientMutationId: axisMutationId, operation: "spaces.taskAxes.create" },
        ]),
      );
      expect(database.mutations).toHaveLength(3);
    } finally {
      await harness.close();
    }
  });
});
