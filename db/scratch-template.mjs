/**
 * A migrated TEMPLATE database per migration chain, so a test harness can
 * clone a ready database instead of migrating a fresh one per suite.
 *
 * WHY. `node db/migrate.mjs up` on a fresh database is 185 files, one psql
 * process each. Measured on a loaded dev box (load ~72, 2026-09-24): 285s,
 * longer than the CLI integration harness's whole 120-180s `beforeAll`
 * budget, so every file in that suite failed before its first test. The same
 * box clones a migrated database in 16-35s. And with ~30 concurrent suites each
 * re-applying 185 migrations, the migrations themselves are a large share of
 * the load that makes everything else slow.
 *
 * WHAT IS PRESERVED. The template is built by the OFFICIAL runner
 * (`db/migrate.mjs up`: lexical order, one transaction per file, the checksum
 * ledger), so a clone is byte-for-byte the database that runner produces.
 *
 * NAMING, and why it is safe to share. `tm8_tpl_<digest>` where the digest
 * covers every migration's name and content, so two branches with different
 * chains never share a template and an edited migration never reuses a stale
 * one. The build happens under a private name, `tm8_tplbuild_<digest>_<pid>_<hex>`,
 * and is RENAMED into place once complete, so a half-built template is never
 * visible under the shared name. Concurrent first builders race; the losers'
 * rename fails, they drop their copy and use the winner's. No lock needed.
 *
 * The template is marked `is_template` and `allow_connections false`: nothing
 * can connect to it, and a connection is the one thing that makes
 * `create database … template` fail.
 *
 * `scripts/pg-scratch-gc.mjs` collects stale templates and abandoned builds.
 */
import { createHash, randomBytes } from 'node:crypto';
import { execFile } from 'node:child_process';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const run = promisify(execFile);
const DB_DIR = dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = join(DB_DIR, 'migrations');
const PSQL = ['-w', '--no-psqlrc', '-X', '-v', 'ON_ERROR_STOP=1', '-q', '-At'];

/** 16 hex of sha256 over every migration's name and content, in lexical order. */
export function migrationChainDigest() {
  const hash = createHash('sha256');
  for (const file of readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith('.sql')).sort()) {
    hash.update(file).update('\0').update(readFileSync(join(MIGRATIONS_DIR, file))).update('\0');
  }
  return hash.digest('hex').slice(0, 16);
}

function withDatabase(url, database) {
  const next = new URL(url);
  next.pathname = `/${database}`;
  return next.href;
}

async function sql(adminUrl, statement, env) {
  const { stdout } = await run('psql', [...PSQL, adminUrl, '-c', statement], { env });
  return stdout.trim();
}

async function exists(adminUrl, name, env) {
  return (await sql(adminUrl, `select 1 from pg_database where datname = '${name}'`, env)) === '1';
}

const ensured = new Map();

/**
 * The name of a migrated template for the current chain, building it if no
 * process has yet. `adminUrl` must point at a maintenance database (`postgres`)
 * as a role that may create databases.
 */
export function ensureMigratedTemplate(adminUrl, env = process.env) {
  const digest = migrationChainDigest();
  const key = `${adminUrl}\0${digest}`;
  let pending = ensured.get(key);
  if (!pending) {
    pending = build(adminUrl, digest, env);
    ensured.set(key, pending);
    pending.catch(() => ensured.delete(key));
  }
  return pending;
}

async function build(adminUrl, digest, env) {
  const name = `tm8_tpl_${digest}`;
  if (await exists(adminUrl, name, env)) return name;

  const staging = `tm8_tplbuild_${digest}_${process.pid}_${randomBytes(6).toString('hex')}`;
  await sql(adminUrl, `create database ${staging}`, env);
  try {
    await run('node', [join(DB_DIR, 'migrate.mjs'), 'up'], {
      env: { ...env, TM8_DATABASE_URL: withDatabase(adminUrl, staging) },
      cwd: join(DB_DIR, '..'),
      maxBuffer: 64 * 1024 * 1024,
    });
    await sql(adminUrl, `alter database ${staging} with is_template true allow_connections false`, env);
    try {
      await sql(adminUrl, `alter database ${staging} rename to ${name}`, env);
      return name;
    } catch (error) {
      // Lost the race: another process published the same chain first.
      if (await exists(adminUrl, name, env)) {
        await dropStaging(adminUrl, staging, env);
        return name;
      }
      throw error;
    }
  } catch (error) {
    await dropStaging(adminUrl, staging, env);
    throw error;
  }
}

async function dropStaging(adminUrl, staging, env) {
  await sql(adminUrl, `alter database ${staging} with is_template false`, env).catch(() => undefined);
  await sql(adminUrl, `drop database if exists ${staging} with (force)`, env).catch(() => undefined);
}

/**
 * `create database <name> template <current template>`, rebuilding the
 * template once if it vanished between lookup and clone (the GC dropped it).
 */
export async function createFromMigratedTemplate(adminUrl, name, env = process.env) {
  if (!/^[a-z_][a-z0-9_]*$/.test(name)) throw new Error(`unsafe database name: ${name}`);
  let template = await ensureMigratedTemplate(adminUrl, env);
  try {
    await sql(adminUrl, `create database ${name} template ${template}`, env);
  } catch (error) {
    if (!/does not exist/.test(String(error?.stderr ?? error))) throw error;
    ensured.clear();
    template = await ensureMigratedTemplate(adminUrl, env);
    await sql(adminUrl, `create database ${name} template ${template}`, env);
  }
  return template;
}
