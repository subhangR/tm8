/**
 * Coordinator E2E seed — Phase 1 live verification. NOT part of the PR.
 * Seeds a scratch DB + blob store with a CDN-referencing artifact, mints a
 * live preview session, prints JSON for the server boot + curl + browser pass.
 */
import { randomUUID } from 'node:crypto';
import { mkdir } from 'node:fs/promises';

import type { ArtifactManifest, ArtifactsCreateInput, CommandResult, OperationName } from '@tm8/contract';
import { OPERATIONS } from '@tm8/contract';

import { PgDb } from './src/db/client.js';
import type { DbClaims } from './src/db/types.js';
import { W2ArtifactsService } from './src/facade/services/w2/artifacts.js';
import type { FacadeDeps } from './src/facade/deps.js';
import type { RequestContext } from './src/http/types.js';
import { createW2BlobStore } from './src/files/w2-blob-store.js';
import { createW1ScratchDatabase, migrationFiles } from './test/db/w1-pg.js';

const PORT = Number(process.env['E2E_PORT'] ?? 4701);
const DATA_DIR = process.env['E2E_DATA_DIR']!;
if (!DATA_DIR) throw new Error('set E2E_DATA_DIR');

function opBinding(name: OperationName) {
  const op = OPERATIONS.find((c) => c.name === name);
  if (!op) throw new Error(`no such operation: ${name}`);
  return op;
}

const database = await createW1ScratchDatabase('e2e-p1');
database.apply(migrationFiles());

const fixture = await database.transaction(async (client) => {
  await client.query('set local role tm8_graph_owner');
  const ids = (await client.query<{ spaceId: string; memberId: string }>(
    `select internal.new_id()::text as "spaceId", internal.new_id()::text as "memberId"`,
  )).rows[0]!;
  const identityId = 'artifacts-owner';
  await client.query(`insert into public.user_profiles(identity_id, display_name) values ($1, 'Artifacts Owner')`, [identityId]);
  await client.query(`insert into public.spaces(id, name, created_by_identity) values ($1, 'Artifacts', $2)`, [ids.spaceId, identityId]);
  await client.query(
    `insert into public.entities(id, space_id, kind, visibility, created_by) values ($1, $2, 'member', 'space', $1)`,
    [ids.memberId, ids.spaceId],
  );
  await client.query(
    `insert into public.members(entity_id, space_id, identity_id, role, display_name) values ($1, $2, $3, 'owner', 'Artifacts Owner')`,
    [ids.memberId, ids.spaceId, identityId],
  );
  return { identityId, spaceId: ids.spaceId, memberId: ids.memberId };
});

await mkdir(DATA_DIR, { recursive: true });
const db = new PgDb({ databaseUrl: database.url });
const blobStore = createW2BlobStore({ dataDir: DATA_DIR });
const owner = {
  identityId: fixture.identityId,
  accountId: 'account-e2e',
  username: 'owner',
  isNodeAdmin: true,
  isOwner: true,
};
const origin = `http://127.0.0.1:${PORT}`;
const service = new W2ArtifactsService(
  {
    db,
    config: {
      preview: { host: '127.0.0.1', port: PORT, origin, sameOrigin: true, frameAncestors: [origin] },
    } as FacadeDeps['config'],
    owner: async () => owner,
  },
  // REAL clock — a frozen `now` would mint an already-expired token.
  { blobStore, now: () => new Date() },
);

const claims = (): DbClaims => ({ identityId: fixture.identityId, nodeAdmin: true, requestId: 'e2e' });
function ctx(opName: OperationName, params: Record<string, string>, body?: unknown): RequestContext {
  return {
    op: opBinding(opName), opName, params, query: new URLSearchParams(), body,
    requestId: 'e2e-request',
    identity: { kind: 'auto-owner', identityId: fixture.identityId },
    headers: {}, method: opBinding(opName).method, path: opBinding(opName).path,
  };
}
async function registerBytes(text: string) {
  const bytes = Buffer.from(text, 'utf8');
  const r = await service.registerBlobBytes(claims(), fixture.spaceId, bytes);
  return { sha256: r.sha256, size: r.sizeBytes };
}

const appJs = await registerBytes(
  `document.getElementById('local').textContent = 'LOCAL-OK';`,
);
const html = await registerBytes(
  `<!doctype html><html><head><title>e2e</title></head><body>` +
  `<div id="local">local waiting</div><div id="cdn">CDN waiting</div>` +
  `<script src="app.js"></script>` +
  `<script src="https://cdn.jsdelivr.net/npm/canvas-confetti@1.9.3/dist/confetti.browser.min.js"></script>` +
  `<script>document.getElementById('cdn').textContent = (typeof confetti === 'function') ? 'CDN-OK' : 'CDN-FAIL';</script>` +
  `</body></html>`,
);

// files sorted ascending by UTF-8 bytes of path: 'app.js' < 'index.html'
const manifest: ArtifactManifest = {
  schema: 'tm8.web-artifact/1',
  runtime: 'web-static-v1',
  entrypoint: 'index.html',
  files: [
    { path: 'app.js', mediaType: 'text/javascript', size: appJs.size, sha256: appJs.sha256 },
    { path: 'index.html', mediaType: 'text/html', size: html.size, sha256: html.sha256 },
  ],
};
const created = (await service.create(
  ctx('artifacts.create', {}, {
    clientMutationId: `create-${randomUUID()}`,
    spaceId: fixture.spaceId,
    name: 'E2E CDN Preview',
    manifest,
  } satisfies ArtifactsCreateInput),
)) as CommandResult;
const artifactId = created.entity!.id;

const preview = (await service.previewStart(
  ctx('artifacts.preview.start', { artifactId }, { clientMutationId: `prev-${randomUUID()}` }),
)) as { previewSessionId: string; token: string; expiresAt: string; previewUrl?: string };

console.log(JSON.stringify({
  dbUrl: database.url,
  dbName: database.name,
  dataDir: DATA_DIR,
  spaceId: fixture.spaceId,
  artifactId,
  previewSessionId: preview.previewSessionId,
  expiresAt: preview.expiresAt,
  previewUrl: preview.previewUrl,
}, null, 2));

// Intentionally NO database.destroy(): the live server boots against this DB next.
await db.end();
await database.pool.end();
process.exit(0);
