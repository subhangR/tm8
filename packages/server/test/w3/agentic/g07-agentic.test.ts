import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { startW3PublicServer, successData } from "../public-harness.js";
import { observeG07DatabaseOutcome } from "../agentic-observer.js";

describe("W3.G07 agentic file lifecycle (generated discovery, real HTTP + raw bytes)", () => {
  let harness;

  beforeAll(async () => {
    harness = await startW3PublicServer("agentic_g07");
  });

  afterAll(async () => {
    await harness.close();
  });

  it("creates a space + task, uploads real raw bytes via the discovered grant, completes, attaches, replays, and downloads with byte-for-byte + checksum proof", async () => {
    const spaceRes = await harness.request("POST", "/v2/spaces", {
      clientMutationId: "g07-space-1",
      name: "G07 Agentic Space",
    });
    expect(spaceRes.status).toBe(201);
    const { space } = successData(spaceRes);
    const spaceId = space.id;

    const taskRes = await harness.request("POST", "/v2/entities", {
      clientMutationId: "g07-entity-1",
      spaceId,
      kind: "task",
      title: "G07 Agentic Target Task",
    });
    expect(taskRes.status).toBe(201);
    const taskEntityId = successData(taskRes).entity.id;

    // Content + checksum are computed here in the test, not read from any fixture.
    const fileBytes = new TextEncoder().encode(`g07-agentic-payload-${taskEntityId}`);
    const digestBuf = await crypto.subtle.digest("SHA-256", fileBytes);
    const checksumHex = Buffer.from(digestBuf).toString("hex");

    const initRes = await harness.request("POST", "/v2/files/uploads", {
      spaceId,
      name: "g07-agentic.txt",
      mime: "text/plain",
      sizeBytes: fileBytes.byteLength,
      checksumSha256: checksumHex,
    });
    expect(initRes.status).toBe(200);
    const grant = successData(initRes);
    expect(grant.uploadId).toBeTruthy();
    expect(grant.uploadUrl).toBeTruthy();
    expect(grant.token).toBeTruthy();

    // The raw upload URL/token are discovered dynamically from this grant response -
    // they are not a semantic catalog operation, so we hit them with plain fetch.
    const rawUploadUrl = new URL(grant.uploadUrl, harness.baseUrl).toString();

    // Negative case: missing grant token must be refused.
    const putNoAuth = await fetch(rawUploadUrl, { method: "PUT", body: fileBytes });
    expect(putNoAuth.status).toBe(401);
    const noAuthBody = await putNoAuth.json();
    expect(noAuthBody.error.code).toBe("unauthenticated");

    // Negative case: wrong grant token must be refused.
    const putWrongToken = await fetch(rawUploadUrl, {
      method: "PUT",
      headers: { Authorization: "Bearer not-the-real-grant-token" },
      body: fileBytes,
    });
    expect(putWrongToken.status).toBe(403);
    const wrongTokenBody = await putWrongToken.json();
    expect(wrongTokenBody.error.code).toBe("forbidden");

    // Real raw-byte PUT using the returned upload URL + grant token.
    const putReal = await fetch(rawUploadUrl, {
      method: "PUT",
      headers: { Authorization: `Bearer ${grant.token}` },
      body: fileBytes,
    });
    expect(putReal.status).toBe(204);

    const completeRes = await harness.request("POST", `/v2/files/uploads/${grant.uploadId}/complete`, {
      clientMutationId: "g07-complete-1",
    });
    expect(completeRes.status).toBe(200);
    const fileEntity = successData(completeRes).entity;
    expect(fileEntity.kind).toBe("file");
    expect(fileEntity.state.name).toBe("g07-agentic.txt");
    expect(fileEntity.state.mimeType).toBe("text/plain");
    expect(fileEntity.state.sizeBytes).toBe(fileBytes.byteLength);
    const fileEntityId = fileEntity.id;

    // Attach the uploaded file to the target task via a discovered attached_to edge
    // (direction confirmed empirically: source=file, destination=task; the reverse
    // direction produced an edge but left the file with no observable attachment target).
    const edgeRes = await harness.request("POST", "/v2/edges", {
      clientMutationId: "g07-edge-1",
      srcId: fileEntityId,
      dstId: taskEntityId,
      type: "attached_to",
    });
    expect(edgeRes.status).toBe(201);
    expect(successData(edgeRes).edge.type).toBe("attached_to");

    // Replay: same clientMutationId against the same upload-complete command must be
    // idempotent, returning the identical file entity rather than erroring or duplicating.
    const replayRes = await harness.request("POST", `/v2/files/uploads/${grant.uploadId}/complete`, {
      clientMutationId: "g07-complete-1",
    });
    expect(replayRes.status).toBe(200);
    expect(successData(replayRes).entity.id).toBe(fileEntityId);

    // Download and prove byte identity + integrity headers.
    const downloadUrl = new URL(`/v2/files/${fileEntityId}/download`, harness.baseUrl).toString();
    const downloadRes = await fetch(downloadUrl);
    expect(downloadRes.status).toBe(200);
    expect(downloadRes.headers.get("content-type")).toBe("text/plain");
    expect(downloadRes.headers.get("content-length")).toBe(String(fileBytes.byteLength));
    expect(downloadRes.headers.get("x-tm8-checksum-sha256")).toBe(checksumHex);
    expect(downloadRes.headers.get("digest")).toBe(`sha-256=${Buffer.from(digestBuf).toString("base64")}`);
    expect(downloadRes.headers.get("etag")).toBe(`"sha256-${checksumHex}"`);

    const downloadedBytes = new Uint8Array(await downloadRes.arrayBuffer());
    expect(Buffer.from(downloadedBytes).equals(Buffer.from(fileBytes))).toBe(true);

    // Bounded DB-outcome proof via the evaluator observer (no direct row access).
    const dbOutcome = await observeG07DatabaseOutcome(
      harness,
      [grant.uploadId],
      fileEntityId,
      ["g07-space-1", "g07-entity-1", "g07-complete-1", "g07-edge-1"],
    );

    expect(dbOutcome.uploads).toHaveLength(1);
    expect(dbOutcome.uploads[0]).toMatchObject({
      uploadId: grant.uploadId,
      status: "completed",
      staged: true,
      fileEntityId,
    });
    expect(dbOutcome.file).toMatchObject({
      id: fileEntityId,
      exists: true,
      name: "g07-agentic.txt",
      mime: "text/plain",
      sizeBytes: fileBytes.byteLength,
      checksumSha256: checksumHex,
    });
    expect(dbOutcome.attachmentTargetIds).toContain(taskEntityId);

    const mutationOps = Object.fromEntries(
      dbOutcome.mutations.map((m) => [m.clientMutationId, m.operation]),
    );
    expect(mutationOps).toMatchObject({
      "g07-space-1": "spaces.create",
      "g07-entity-1": "entities.create",
      "g07-complete-1": "files.uploadComplete",
      "g07-edge-1": "edges.create",
    });
    // Same 120s budget and the same reason as its siblings: this `it` boots the
    // DB-backed harness itself. It currently lands just inside vitest's 5s
    // default, which is not a margin — it is a coin flip on a loaded runner.
  }, 120_000);
});
