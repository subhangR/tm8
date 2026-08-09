import { afterEach, describe, expect, it } from "vitest";

import { startW3PublicServer, successData } from "../public-harness.js";
import {
  observeG08DatabaseOutcome,
  seedG08NotificationFixture,
} from "../agentic-observer.js";

type CreatedSpace = { space: { id: string }; memberId: string };
type CreatedEntity = { entity: { id: string } };
type InboxItem = { id: string; readAt: string | null };
type InboxPage = { items: InboxItem[]; nextCursor: string | null };
type MarkReadResult = { id: string; readAt: string | null };
type ReadMarkResult = { anchorId: string; lastReadAt: string };

describe("W3.G08 agentic generated-discovery inbox/read-mark gate", () => {
  let harness: Awaited<ReturnType<typeof startW3PublicServer>> | undefined;

  afterEach(async () => {
    await harness?.close();
  });

  it("keeps personal and Teammate notification/read state separate across replay-safe mutations", async () => {
    harness = await startW3PublicServer("agentic_g08");
    const run = `g08-${Date.now()}`;
    const markReadMutationId = `${run}-mark-read`;
    const readMarkMutationId = `${run}-read-mark`;

    const createSpace = await harness.request("POST", "/v2/spaces", {
      name: `G08 ${run}`,
      clientMutationId: `${run}-space`,
    });
    expect(createSpace.status).toBe(201);
    const { space, memberId } = successData(createSpace) as CreatedSpace;

    const createAnchor = await harness.request("POST", "/v2/entities", {
      spaceId: space.id,
      kind: "task",
      title: `Anchor ${run}`,
      clientMutationId: `${run}-anchor`,
    });
    expect(createAnchor.status).toBe(201);
    const { entity: anchor } = successData(createAnchor) as CreatedEntity;

    const createTeammate = await harness.request("POST", "/v2/entities", {
      spaceId: space.id,
      kind: "team_member",
      title: `Teammate ${run}`,
      clientMutationId: `${run}-teammate`,
    });
    expect(createTeammate.status).toBe(201);
    const { entity: teammate } = successData(createTeammate) as CreatedEntity;

    const notifications = await seedG08NotificationFixture(harness, {
      spaceId: space.id,
      memberId,
      teammateId: teammate.id,
      targetId: anchor.id,
    });

    const personalBefore = await harness.request("GET", "/v2/inbox");
    expect(personalBefore.status).toBe(200);
    const personalBeforePage = successData(personalBefore) as InboxPage;
    expect(personalBeforePage.items).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: notifications.memberNotificationId,
          readAt: null,
        }),
      ]),
    );
    expect(personalBeforePage.items).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: notifications.teammateNotificationId }),
      ]),
    );

    const unreadBefore = await harness.request("GET", "/v2/inbox?unread=true");
    expect(unreadBefore.status).toBe(200);
    expect((successData(unreadBefore) as InboxPage).items).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: notifications.memberNotificationId,
          readAt: null,
        }),
      ]),
    );

    const strictRecipientRefusal = await harness.request(
      "GET",
      `/v2/inbox?recipient=${encodeURIComponent(JSON.stringify({}))}`,
    );
    expect(strictRecipientRefusal.status).toBe(400);
    expect(strictRecipientRefusal.body.error.code).toBe("invalid_input");

    const markReadBody = { clientMutationId: markReadMutationId };
    const markRead = await harness.request(
      "PUT",
      `/v2/inbox/${notifications.memberNotificationId}/read`,
      markReadBody,
    );
    const markReadReplay = await harness.request(
      "PUT",
      `/v2/inbox/${notifications.memberNotificationId}/read`,
      markReadBody,
    );
    expect(markRead.status).toBe(200);
    expect(markReadReplay.status).toBe(200);
    expect(successData(markRead) as MarkReadResult).toEqual(
      successData(markReadReplay) as MarkReadResult,
    );

    const readMarkBody = { clientMutationId: readMarkMutationId };
    const readMark = await harness.request(
      "PUT",
      `/v2/read-marks/${anchor.id}`,
      readMarkBody,
    );
    const readMarkReplay = await harness.request(
      "PUT",
      `/v2/read-marks/${anchor.id}`,
      readMarkBody,
    );
    expect(readMark.status).toBe(200);
    expect(readMarkReplay.status).toBe(200);
    expect(successData(readMark) as ReadMarkResult).toEqual(
      successData(readMarkReplay) as ReadMarkResult,
    );

    const [personalAfter, unreadAfter] = await Promise.all([
      harness.request("GET", "/v2/inbox"),
      harness.request("GET", "/v2/inbox?unread=true"),
    ]);
    expect(personalAfter.status).toBe(200);
    expect(unreadAfter.status).toBe(200);
    expect((successData(personalAfter) as InboxPage).items).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: notifications.memberNotificationId,
          readAt: expect.any(String),
        }),
      ]),
    );
    expect((successData(unreadAfter) as InboxPage).items).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: notifications.memberNotificationId }),
      ]),
    );

    const databaseOutcome = await observeG08DatabaseOutcome(
      harness,
      [notifications.memberNotificationId, notifications.teammateNotificationId],
      memberId,
      anchor.id,
      [markReadMutationId, readMarkMutationId],
    );
    expect(databaseOutcome).toMatchObject({
      notifications: expect.arrayContaining([
        {
          id: notifications.memberNotificationId,
          recipientMemberId: memberId,
          recipientTeammateId: null,
          read: true,
        },
        {
          id: notifications.teammateNotificationId,
          recipientMemberId: memberId,
          recipientTeammateId: teammate.id,
          read: false,
        },
      ]),
      readMark: { exists: true, lastReadAt: expect.any(String) },
      mutations: expect.arrayContaining([
        { clientMutationId: markReadMutationId, operation: "inbox.markRead" },
        { clientMutationId: readMarkMutationId, operation: "readMarks.upsert" },
      ]),
    });
    console.log("G08 bounded database outcome", JSON.stringify(databaseOutcome));
    // 120s, the same budget every other DB-backed suite in this tree uses
    // (g15-agentic:88 and :212, public-harness, the w2 pg suites). This `it`
    // calls startW3PublicServer ITSELF rather than in a beforeAll, so the test
    // timeout — not a hook timeout — has to cover creating a scratch database
    // and applying the whole migration chain before the workflow starts. On
    // vitest's 5s default that was never survivable once the chain passed ~70
    // files, and this suite died at `Test timed out in 5000ms` with nothing to
    // say which assertion was at fault.
  }, 120_000);
});
