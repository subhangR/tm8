import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { startW3PublicServer, successData, type W3PublicServer } from './public-harness.js';

/**
 * W3.G04 — `messages.edit` absent-means-merge, all three branches.
 *
 * 037's second fix was the same class as its first, in a different disguise:
 * `w2_edit_message` did `coalesce(p_mention_ids,'{}')` and then overwrote, so an
 * edit that said nothing about mentions WIPED them. It needed no new flag —
 * `uuid[]` already expresses the three cases: NULL absent, `{}` explicit clear,
 * non-empty replace.
 *
 * WHY THIS OPERATION AND NOT ANOTHER. Its sibling fix, `set_work_state`, is
 * gated separately and its three-way distinction is NOT reachable through the
 * API: `handlers/commands.ts:38` passes `input.note ?? null`, so absent and
 * explicit-null collapse to one wire value and an explicit clear returns 200
 * having done nothing.
 *
 * `messages.edit` is the SAME CLASS IN THE SAME REPOSITORY AND IT GOT IT RIGHT.
 * `services/w2/messages-handoffs.ts:377-379` reads:
 *     const mentionIds = input.mentions === undefined ? null : uniqueIds(...)
 * and its own comment names the exact trap the work handler fell into — that
 * `input.mentions ?? []` would collapse "said nothing" into "clear" BEFORE the
 * RPC ever sees it and silently wipe stored mentions on any edit that did not
 * restate them.
 *
 * So this file proves the distinction is LIVE at the public boundary, all three
 * branches, on the operation where it is expressible. That contrast is the
 * point: two handlers, one class, one repository, one correct and one not.
 *
 * MIGRATIONS: full official chain via `migrationFiles()`.
 */
describe.sequential('W3.G04 messages.edit mention merge, three branches', () => {
  let harness: W3PublicServer;
  let spaceId = '';
  let anchorId = '';
  let memberId = '';
  let messageId = '';
  let version = 1;

  async function storedMentions(): Promise<unknown[]> {
    const rows = await harness.rows<{ mentions: unknown[] }>(
      'select mentions from public.messages where entity_id = $1',
      [messageId],
    );
    const value = rows[0]?.mentions;
    return Array.isArray(value) ? value : [];
  }

  async function edit(cmid: string, body: string, mentions?: unknown[]): Promise<number> {
    const payload: Record<string, unknown> = {
      clientMutationId: cmid,
      expectedVersion: version,
      body,
    };
    if (mentions !== undefined) payload['mentions'] = mentions;
    const res = await harness.request<{ version?: number }>('PATCH', `/v2/messages/${messageId}`, payload);
    expect(res.status, `${cmid}: ${JSON.stringify(res.body)}`).toBe(200);
    version = res.body.data?.version ?? version + 1;
    return res.status;
  }

  beforeAll(async () => {
    harness = await startW3PublicServer('g04edit');
    const space = successData<{ space: { id: string } }>(
      await harness.request('POST', '/v2/spaces', {
        clientMutationId: 'w3-g04edit-space',
        name: 'W3 G04 edit Space',
      }),
    );
    spaceId = space.space.id;

    const members = await harness.rows<{ id: string }>(
      `select id::text from public.entities
        where space_id = $1 and kind = 'member' and deleted_at is null limit 1`,
      [spaceId],
    );
    memberId = members[0]?.id ?? '';

    const anchor = successData<{ entity: { id: string } }>(
      await harness.request('POST', '/v2/entities', {
        clientMutationId: 'w3-g04edit-anchor',
        spaceId,
        kind: 'task',
        title: 'G04 edit anchor',
        content: { priority: 'medium' },
      }),
    );
    anchorId = anchor.entity.id;

    const posted = await harness.request<{ messages: Array<{ id: string; version: number }> }>(
      'POST',
      '/v2/messages',
      {
        clientMutationId: 'w3-g04edit-post',
        anchorIds: [anchorId],
        body: 'G04 edit subject with a mention',
        mentionIds: [memberId],
      },
    );
    messageId = posted.body.data?.messages?.[0]?.id ?? '';
    version = posted.body.data?.messages?.[0]?.version ?? 1;
  }, 180_000);

  // 30s -> 120s. `harness.close()` ends with `database.destroy()`, which DROPS a
  // scratch database, and a drop is exactly the operation that slows down under
  // the parallel load this suite runs in — w2-execution.pg.test.ts measured the
  // same thing and raised its own teardown budget for it. All twenty w3 suites
  // shared this 30s, so whichever one lost the race reported `Hook timed out in
  // 30000ms` and the identity of the loser rotated between runs. A larger budget
  // costs nothing when teardown is fast.
  afterAll(async () => {
    await harness?.close();
  }, 120_000);

  it('CONTROL: the fixture stored a mention, so the branches below are not vacuous', async () => {
    expect(memberId, 'no member entity to mention').toBeTruthy();
    expect(messageId, 'messages.post did not return a message').toBeTruthy();
    expect(
      (await storedMentions()).length,
      'the fixture stored no mentions — preservation and clearing would be indistinguishable',
    ).toBeGreaterThan(0);
  });

  it('BRANCH 1 — ABSENT: an edit that omits mentions PRESERVES them', async () => {
    const before = await storedMentions();
    await edit('w3-g04edit-absent', 'edited body, mentions not restated');
    const after = await storedMentions();
    expect(
      after,
      'an edit that said nothing about mentions WIPED them — this is the exact collapse the '
        + 'handler comment at messages-handoffs.ts:369-375 exists to prevent',
    ).toEqual(before);
    expect(after.length).toBeGreaterThan(0);
  }, 60_000);

  it('BRANCH 2 — EXPLICIT EMPTY: an edit sending mentions: [] CLEARS them', async () => {
    expect((await storedMentions()).length, 'nothing to clear').toBeGreaterThan(0);
    await edit('w3-g04edit-clear', 'edited body, mentions explicitly cleared', []);
    expect(
      (await storedMentions()).length,
      'an explicit empty mentions array did NOT clear — then absent and explicit-empty are '
        + 'indistinguishable at the API, which is the set_work_state failure in a second place',
    ).toBe(0);
  }, 60_000);

  it('BRANCH 3 — NON-EMPTY: an edit sending a mention REPLACES', async () => {
    await edit('w3-g04edit-replace', 'edited body, mention restored', [
      { entityId: memberId, kind: 'member', display: 'Owner' },
    ]);
    const after = await storedMentions();
    expect(after.length, 'a non-empty mentions array did not replace').toBeGreaterThan(0);
    expect(JSON.stringify(after)).toContain(memberId);
  }, 60_000);
});
