/**
 * W10d a4, ruled (B) on 2026-09-28 (task 01a0e743): a backup is the whole
 * database, so it KEEPS space_credentials' ciphertext (a restore keeps every
 * credential), and it NEVER holds the node key that opens it — that key is a
 * file in dataDir (`credential-key.ts`), outside the database.
 *
 * Two cells, against a REAL PostgreSQL with every migration applied and one
 * credential sealed through the real store:
 *
 *   1. Every table in every non-system schema, as text, holds no form of the
 *      node key (hex, base64); the credential's ciphertext is in its row.
 *   2. The real artifact: `pgDump()` → `pg_restore -f -`. The key is absent from
 *      the artifact's bytes and its restored text; the ciphertext is present.
 *      This needs a pg_dump no older than the server. CI's runner ships
 *      pg_dump 16 against a postgres:17 service, so there the cell SKIPS, and
 *      its name and a warning say why — it never passes silently.
 *
 * Needles are compared with includes/LIKE only. No key byte is ever printed:
 * a failure names the surface and a sha256 prefix of the needle, not the needle.
 */
import { execFileSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, readdirSync } from 'node:fs';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { credentialKeyPath, resetCredentialKeyCache } from '../../src/credentials/credential-key.js';
import { DbSpaceCredentialStore } from '../../src/credentials/space-credential-store.js';
import { createDb } from '../../src/db/index.js';
import type { Db, DbClaims } from '../../src/db/types.js';
import { pgDump } from '../../src/sidecar/backup.js';
import { silentLogger } from '../../src/sidecar/log.js';
import { testAdminUrl } from './pg-port-guard.js';
import { createW1ScratchDatabase, migrationFiles, type W1ScratchDatabase } from './w1-pg.js';

const OWNER = 'backup-owner';
const tag = (needle: string): string => createHash('sha256').update(needle).digest('hex').slice(0, 12);

/** The server's major version, and a pg_dump/pg_restore pair no older than it (or why there is none). */
async function dumpTools(): Promise<{ bin: string | null; reason: string }> {
  const admin = new pg.Client({ connectionString: testAdminUrl() });
  await admin.connect();
  const { rows } = await admin.query<{ v: string }>("select current_setting('server_version_num') v");
  await admin.end();
  const serverMajor = Math.floor(Number(rows[0]!.v) / 10000);
  const candidates = [
    ...(existsSync('/usr/lib/postgresql') ? readdirSync('/usr/lib/postgresql').map((v) => `/usr/lib/postgresql/${v}/bin`) : []),
    ...(process.env['PATH'] ?? '').split(':'),
  ].filter((d) => d && existsSync(join(d, 'pg_dump')) && existsSync(join(d, 'pg_restore')));
  let best = 0;
  for (const dir of candidates) {
    const out = execFileSync(join(dir, 'pg_dump'), ['--version'], { encoding: 'utf8' });
    const major = Number(/(\d+)(?:\.\d+)?/.exec(out.replace(/^[^\d]*/, ''))?.[1] ?? 0);
    if (major >= serverMajor) return { bin: dir, reason: `pg_dump ${major} >= server ${serverMajor}` };
    best = Math.max(best, major);
  }
  return { bin: null, reason: `pg_dump ${best || 'none'} < server ${serverMajor}` };
}

const tools = await dumpTools();
if (!tools.bin) {
  console.warn(`[backup-credentials] SKIPPING the real-artifact cell: ${tools.reason}. Only the table scan runs here.`);
}

let database: W1ScratchDatabase;
let db: Db;
let dataDir: string;
let credentialId: string;
let needles: string[] = [];
let ciphertextHex = '';

const claims = (identityId: string): DbClaims =>
  ({ identityId, nodeAdmin: false, requestId: randomUUID(), authKind: 'browser' }) as DbClaims;

beforeAll(async () => {
  dataDir = await mkdtemp(join(tmpdir(), 'tm8-backup-cred-'));
  resetCredentialKeyCache();
  database = await createW1ScratchDatabase('backup_credentials');
  database.apply(migrationFiles());
  db = createDb(database.url);
  const spaceId = await database.transaction(async (c) => {
    await c.query('set local role tm8_graph_owner');
    const id = async () => (await c.query<{ id: string }>('select internal.new_id()::text id')).rows[0]!.id;
    await c.query(`insert into public.user_profiles(identity_id, display_name) values ($1, $1)`, [OWNER]);
    await c.query(`insert into public.accounts(identity_id, username, display_name) values ($1, $1, $1)`, [OWNER]);
    const space = await id();
    await c.query(`insert into public.spaces(id, name, created_by_identity) values ($1, 'BK', $2)`, [space, OWNER]);
    const member = await id();
    await c.query(`insert into public.entities(id, space_id, kind, position, created_by) values ($1, $2, 'member', 0, $1)`, [member, space]);
    await c.query(`insert into public.members(entity_id, space_id, identity_id, role, display_name) values ($1, $2, $3, 'owner', $3)`, [member, space, OWNER]);
    return space;
  });
  const store = new DbSpaceCredentialStore({ db, dataDir, logger: { warn: () => undefined } });
  const made = await store.create(claims(OWNER), {
    spaceId, provider: 'anthropic', shape: 'api_key', label: 'backup canary',
    secret: `sk-ant-BackupFakeCanary-${randomUUID().replaceAll('-', '')}Qz9x`,
  });
  credentialId = made.id;
  const key = await readFile(credentialKeyPath(dataDir));
  needles = [key.toString('hex'), key.toString('base64'), key.toString('base64url')];
  const [row] = await database.query<{ hex: string }>(
    `select encode(secret_ciphertext, 'hex') hex from public.space_credentials where id = $1`, [credentialId]);
  ciphertextHex = row!.hex;
}, 300_000);

afterAll(async () => {
  await db?.end();
  await database?.destroy();
  if (dataDir) await rm(dataDir, { recursive: true, force: true });
  resetCredentialKeyCache();
});

describe('W10d a4 (B) — a backup keeps the ciphertext and never the node key', () => {
  it('no table in any schema holds the node key; the credential row holds its ciphertext', async () => {
    expect(ciphertextHex.length, 'the sealed secret is stored').toBeGreaterThan(32);
    const { rows: tables } = await database.transaction(async (c) => c.query<{ s: string; t: string }>(
      `select table_schema s, table_name t from information_schema.tables
        where table_schema not in ('pg_catalog', 'information_schema') and table_type = 'BASE TABLE'`));
    const hits: string[] = [];
    for (const { s, t } of tables) {
      for (const needle of needles) {
        const [row] = await database.query<{ n: number }>(
          `select count(*)::int n from "${s}"."${t}" x where x::text like '%' || $1 || '%'`, [needle]);
        if (row!.n > 0) hits.push(`${s}.${t}:${tag(needle)}`);
      }
    }
    expect(hits).toEqual([]);
    // Paired positive, same scan: the ciphertext IS in its row, so a whole-DB dump carries it.
    const [pos] = await database.query<{ n: number }>(
      `select count(*)::int n from public.space_credentials x where x::text like '%' || $1 || '%'`, [ciphertextHex]);
    expect(pos!.n).toBe(1);
  });

  it.skipIf(!tools.bin)(`the real artifact: no node key in its bytes or restored text; the ciphertext is present (${tools.reason})`, async () => {
    const out = join(dataDir, 'backups', 'on-demand', 'credential-check.dump');
    const url = new URL(database.url);
    await pgDump(
      { binariesDir: tools.bin!, socketDir: url.hostname, pgPort: Number(url.port), database: database.name, superuser: decodeURIComponent(url.username) },
      { outPath: out, tier: 'on-demand', logger: silentLogger },
    );
    const bytes = await readFile(out);
    const key = await readFile(credentialKeyPath(dataDir));
    expect(bytes.includes(key), 'artifact bytes hold the raw key').toBe(false);
    const text = execFileSync(join(tools.bin!, 'pg_restore'), ['-f', '-', out], { encoding: 'utf8', maxBuffer: 512 * 1024 * 1024 });
    const found = needles.filter((n) => text.includes(n) || bytes.includes(Buffer.from(n))).map(tag);
    expect(found).toEqual([]);
    expect(text.includes('.git-credential.key')).toBe(false);
    // Paired positive: the restore keeps the credential — its ciphertext is in the dump.
    expect(text.includes(`\\\\x${ciphertextHex}`) || text.includes(`\\x${ciphertextHex}`), 'ciphertext restored').toBe(true);
  });
});
