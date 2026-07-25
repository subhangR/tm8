/**
 * GOLDEN WORKFLOW 5 — Orient a newcomer.
 *
 * Source: docs/collab-v2-ui-plan/01-IMPLEMENTATION-PLAN.md Layer 8 §5
 *   "Home self-explains → Graph focus on milestone → channel shelf"
 *
 * This is the READ workflow, and it carries the read-side contract rules the
 * other four don't exercise: server-owned preset expansion (the same `home`
 * preset must mean the same thing for the UI, the CLI and an agent — 02 §3.5),
 * honest keyset pagination (DEV-5), and the honest 501 for the deferred search
 * slot (DEV-13). Those three are how a newcomer — human or agent — gets a true
 * picture instead of a plausible one.
 */
import { assertPage } from '../../lib/http.mjs';
import { ok, equal, hasKeys } from '../../lib/assert.mjs';

export const id = '05-orient-a-newcomer';
export const title = 'Orient a newcomer — Home self-explains, graph focus, channel shelf, honest paging';
export const source = 'ui-plan Layer 8 §5';

export async function run({ client, world, rec }) {
  await rec.step(
    'Home self-explains: three server-defined presets + compact activity, in one call',
    async () => {
      const { data } = await client.call('spaces.home', { params: { spaceId: world.spaceId } });
      hasKeys(
        data,
        ['readyToPull', 'inFlight', 'needsMe', 'activity'],
        'HomeSnapshot must carry all three presets plus activity — the point of Home is that ONE ' +
          'call explains the space; N calls stitched client-side is the thing this replaces',
      );
      for (const preset of ['readyToPull', 'inFlight', 'needsMe']) {
        ok(
          data[preset].query,
          `${preset} must return the CollectionQuery that produced it — the preset has to be ` +
            're-executable by any consumer, which is what makes it server-owned (02 §3.5)',
        );
        assertPage(`spaces.home.${preset}`, data[preset].page);
      }
    },
    { operation: 'spaces.home', docRef: 'api-design 02 §3.5 + contract HomeSnapshot' },
  );

  await rec.step(
    'the ready-to-work preset excludes anything with unresolved hard dependencies',
    async () => {
      const { data } = await client.call('collections.query', {
        body: { spaceId: world.spaceId, kinds: ['task'], filters: { readyToPull: true }, limit: 50 },
      });
      const page = assertPage('collections.query(readyToPull)', data.page);
      const blocked = page.items.filter((e) => (e.badges?.blocked?.unresolvedHardDependencyCount ?? 0) > 0);
      equal(
        blocked.length,
        0,
        'readyToPull must never surface a blocked task — this preset is what an agent asks ' +
          '"what can I pull", and a wrong answer here wastes a whole agent run (01 §5.2 ready_to_work)',
      );
    },
    { operation: 'collections.query', docRef: 'api-design 01 §5.2' },
  );

  await rec.step(
    'the navigation tree gives the channel shelf with unread totals',
    async () => {
      const { data } = await client.call('spaces.navigation', { params: { spaceId: world.spaceId } });
      hasKeys(data, ['viewer', 'channels', 'unreadTotal'], 'SpaceNavigation shape');
      ok(
        data.channels.some((c) => c.entity.id === world.channelId),
        'the seeded channel must appear on the shelf',
      );
    },
    { operation: 'spaces.navigation', docRef: 'contract SpaceNavigation' },
  );

  await rec.step(
    'the channel self-describes with auto-tabs, each carrying its own re-runnable query',
    async () => {
      const { data } = await client.call('entities.get', { params: { id: world.channelId } });
      const tabs = data.content?.autoTabs ?? [];
      ok(tabs.length > 0, 'a channel must expose auto-tabs (the "shelf") — derived server-side, L3');
      for (const tab of tabs) {
        hasKeys(tab, ['key', 'label', 'count', 'query'], 'ChannelTab shape');
        equal(
          tab.query.spaceId,
          world.spaceId,
          'each auto-tab must carry a runnable, space-scoped CollectionQuery, not an opaque label',
        );
      }
    },
    { operation: 'entities.get', docRef: 'contract ChannelTab / UI contract §6 autoTabs' },
  );

  await rec.step(
    'graph focus on the milestone returns the dependency neighbourhood with its clusters',
    async () => {
      const { data } = await client.call('graph.query', {
        body: {
          spaceId: world.spaceId,
          focusId: world.taskId,
          hops: 2,
          mode: 'dependency',
          edgeTypes: ['depends_on', 'attached_to', 'tracks'],
        },
      });
      hasKeys(data, ['nodes', 'edges', 'clusters'], 'GraphResult shape');
      ok(data.nodes.some((n) => n.id === world.taskId), 'the focus entity must be in its own neighbourhood');
      ok(
        data.edges.length > 0,
        'a dependency-mode graph around a task with a dependent and an attached doc must return edges',
      );
    },
    { operation: 'graph.query', docRef: 'api-design 02 §3.5' },
  );

  // ---- honest paging (DEV-5) ------------------------------------------------
  await rec.step(
    'keyset paging is honest: pages do not overlap and nextCursor:null means exhausted',
    async () => {
      const query = { spaceId: world.spaceId, kinds: ['task'], sort: 'createdAt_desc', limit: 2 };
      const { data: first } = await client.call('collections.query', { body: query });
      const p1 = assertPage('collections.query(page1)', first.page);

      if (p1.nextCursor === null) {
        ok(true, 'single page — exhausted immediately, which is a valid honest answer');
        return;
      }
      const { data: second } = await client.call('collections.query', {
        body: { ...query, cursor: p1.nextCursor },
      });
      const p2 = assertPage('collections.query(page2)', second.page);

      const overlap = p1.items.filter((a) => p2.items.some((b) => b.id === a.id));
      equal(
        overlap.length,
        0,
        'keyset pages must not repeat rows — overlap is the offset-pagination bug DEV-5 exists to kill',
      );
    },
    { operation: 'collections.query', docRef: '04 §3 (keyset cursors), DEV-5' },
  );

  await rec.step(
    'a malformed cursor is rejected cleanly as invalid_cursor, never misread',
    async () => {
      const res = await client.call('collections.query', {
        body: { spaceId: world.spaceId, kinds: ['task'], cursor: 'not-a-real-cursor', limit: 2 },
        expectStatus: 400,
      });
      equal(
        res.error.code,
        'invalid_cursor',
        'a stale/foreign cursor must be `invalid_cursor` (v-tagged rejection), not silently treated as an offset',
      );
    },
    { operation: 'collections.query', docRef: '04 §3.2 (version-tagged cursors)' },
  );

  // ---- the honest feature gate (DEV-13) --------------------------------------
  await rec.step(
    'search is deferred and says so honestly: 501 not_implemented, never 404',
    async () => {
      const res = await client.call('search.query', {
        query: { spaceId: world.spaceId, q: 'cursor' },
        expectStatus: 501,
      });
      equal(
        res.error.code,
        'not_implemented',
        'a reserved operation must answer 501 not_implemented — a 404 is indistinguishable from a typo, ' +
          'and the T-L1 composition story depends on nodes being honest about what they do not run (DEV-13)',
      );
    },
    { operation: 'search.query', docRef: 'api-design 01 §S1 + 04 §4 (501 row), DEV-13' },
  );

  return world;
}
