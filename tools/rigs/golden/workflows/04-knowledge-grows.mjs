/**
 * GOLDEN WORKFLOW 4 — Knowledge grows.
 *
 * Source: docs/history/collab-v2/ui-plan/01-IMPLEMENTATION-PLAN.md Layer 8 §4
 *   "promote thread message → doc child of spec, linked forever"
 *
 * "Linked forever" is the whole test. Promotion is trivial to fake — copy the
 * text into a new doc and you have a screenshot that looks right. What makes it
 * real is that the promotion is ONE transaction (`attachTo` on create, 02 §3.1)
 * and the provenance edge survives independently of the text: the doc must
 * still point back at the message after both have been edited, and the message
 * must remain readable in its thread rather than being consumed by the promotion.
 */
import { assertCommandResult, assertPage } from '../../lib/http.mjs';
import { ok, equal } from '../../lib/assert.mjs';
import { entityIdOf } from '../lib/world.mjs';

export const id = '04-knowledge-grows';
export const title = 'Knowledge grows — promote a thread message into a doc child of the spec, linked forever';
export const source = 'ui-plan Layer 8 §4';

export async function run({ client, world, rec }) {
  const anchorId = world.taskId;
  ok(anchorId, 'workflow 04 anchors on the task from workflow 01');

  const messageId = await rec.step(
    'someone posts a keeper into the thread',
    async () => {
      const { data } = await client.mutate('messages.post', {
        body: {
          anchorId,
          body:
            'Decision: cursors are opaque base64 of {v:2,k:[...]}. Version-tagged so stale ' +
            'cursors 400 cleanly instead of being misread as offsets.',
        },
      });
      const result = assertCommandResult('messages.post(keeper)', data);
      return result.entity.id;
    },
    { operation: 'messages.post', docRef: 'api-design 02 §3.4' },
  );

  const promotedDocId = await rec.step(
    'promote it: a doc child of the spec AND the provenance edge, in one create',
    async () => {
      const { data } = await client.mutate('entities.create', {
        body: {
          spaceId: world.spaceId,
          kind: 'doc',
          title: 'Decision: keyset cursors are version-tagged',
          parentId: world.specDocId,
          content: {
            body: '# Decision\n\nCursors are opaque base64 of `{v:2,k:[...]}`; stale cursors 400.\n',
            format: 'markdown',
          },
          // The atomic half of promotion: create + link, never create-then-link.
          attachTo: { entityId: messageId, edgeType: 'relates_to' },
        },
      });
      const result = assertCommandResult('entities.create(promoted doc)', data);
      const docId = entityIdOf('entities.create(promoted doc)', data);
      equal(
        result.entity.parentId,
        world.specDocId,
        'the promoted doc must be a CHILD of the spec — homogeneous hierarchy, same kind, same space',
      );
      return docId;
    },
    { operation: 'entities.create', docRef: 'api-design 02 §3.1 (attachTo: create + edge, one txn)' },
  );

  await rec.step(
    'the source message survives the promotion, still readable in its thread',
    async () => {
      const { data } = await client.call('messages.list', {
        params: { anchorId },
        query: { limit: 100 },
      });
      const page = assertPage('messages.list', data.page ?? data);
      const original = page.items.find((m) => m.id === messageId);
      ok(original, 'promotion must not consume the message — the thread is its own record');
      equal(original.deletedAt, null, 'the promoted-from message must not be tombstoned');
    },
    { operation: 'messages.list', docRef: 'api-design 02 §3.4' },
  );

  await rec.step(
    'the doc appears in the spec\'s subtree (hierarchy, not just an edge)',
    async () => {
      const { data } = await client.call('entities.children', {
        params: { id: world.specDocId },
        query: { limit: 50 },
      });
      const page = assertPage('entities.children', data.page ?? data);
      ok(
        page.items.some((e) => e.id === promotedDocId),
        'the promoted doc must be a real child of the spec, reachable by walking the tree',
      );
    },
    { operation: 'entities.children', docRef: 'api-design 02 §3.1' },
  );

  await rec.step(
    'LINKED FOREVER: the provenance edge survives edits to both ends',
    async () => {
      // Edit the doc.
      const { data: docNow } = await client.call('entities.get', { params: { id: promotedDocId } });
      await client.mutate('entities.patch', {
        params: { id: promotedDocId },
        body: {
          expectedVersion: docNow.version,
          content: { body: docNow.content.body + '\n(revised after review)\n' },
        },
      });
      // Edit the message.
      const { data: msgNow } = await client.call('entities.get', { params: { id: messageId } });
      await client.mutate('messages.edit', {
        params: { id: messageId },
        body: { body: 'Decision (clarified): cursors are opaque, version-tagged base64.', expectedVersion: msgNow.version },
      });

      const { data } = await client.call('edges.list', {
        query: { src: promotedDocId, type: 'relates_to', direction: 'outgoing' },
      });
      const page = assertPage('edges.list', data.page ?? data);
      ok(
        page.items.some((e) => e.dstId === messageId || e.dst?.id === messageId),
        'the provenance edge must still connect the doc to its source message after BOTH were edited — ' +
          '"linked forever" means the link is an edge, not a copied string',
      );
    },
    { operation: 'edges.list', docRef: 'api-design 02 §3.3' },
  );

  await rec.step(
    'the doc\'s edit is snapshotted — knowledge has history, not just a version number',
    async () => {
      const { data } = await client.call('entities.versions', {
        params: { id: promotedDocId },
        query: { limit: 20 },
      });
      const page = assertPage('entities.versions', data.page ?? data);
      ok(
        page.items.length >= 1,
        'a doc edit must produce an entity_versions snapshot (01 §5.1 — the audited hole was docs ' +
          'bumping version with NO snapshot; this step exists to keep that fixed)',
      );
    },
    { operation: 'entities.versions', docRef: 'api-design 01 §5.1 (snapshot trigger)' },
  );

  world.promotedDocId = promotedDocId;
  return world;
}
