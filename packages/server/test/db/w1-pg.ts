import { randomUUID } from 'node:crypto';
import { existsSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { Pool, type PoolClient, type QueryResultRow } from 'pg';

const HERE = dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = resolve(HERE, '../../../..');
export const MIGRATIONS_DIR = join(REPO_ROOT, 'db', 'migrations');

function psqlPath(): string {
  if (process.env['TM8_PSQL']) return process.env['TM8_PSQL'];
  for (const candidate of [
    '/opt/homebrew/opt/postgresql@18/bin/psql',
    '/usr/local/opt/postgresql@18/bin/psql',
    '/usr/lib/postgresql/18/bin/psql',
    'psql',
  ]) {
    if (candidate === 'psql' || existsSync(candidate)) return candidate;
  }
  throw new Error('psql is required for W1 migration rehearsals');
}

function configuredAdminUrl(): string {
  const configured =
    process.env['TM8_W1_ADMIN_DATABASE_URL'] ??
    process.env['TM8_MIGRATION_DATABASE_URL'] ??
    process.env['TM8_DATABASE_URL'] ??
    'postgres://tm8@127.0.0.1:5442/postgres';
  const url = new URL(configured);
  url.pathname = `/${process.env['TM8_ADMIN_DB'] ?? 'postgres'}`;
  return url.toString();
}

function databaseUrl(adminUrl: string, database: string): string {
  const url = new URL(adminUrl);
  url.pathname = `/${database}`;
  return url.toString();
}

export function migrationFiles(): string[] {
  return readdirSync(MIGRATIONS_DIR)
    .filter((file) => /^\d{3}_[a-z0-9_]+\.sql$/.test(file))
    .sort();
}

export interface W1ScratchDatabase {
  readonly name: string;
  readonly url: string;
  readonly pool: Pool;
  apply(files: readonly string[]): void;
  query<R extends QueryResultRow = QueryResultRow>(sql: string, params?: readonly unknown[]): Promise<R[]>;
  transaction<T>(fn: (client: PoolClient) => Promise<T>): Promise<T>;
  destroy(): Promise<void>;
}

export async function createW1ScratchDatabase(label: string): Promise<W1ScratchDatabase> {
  const safeLabel = label.toLowerCase().replace(/[^a-z0-9]+/g, '_').slice(0, 20);
  const suffix = randomUUID().replaceAll('-', '').slice(0, 12);
  const name = `tm8_w1_${safeLabel}_${process.pid}_${suffix}`;
  if (!/^tm8_w1_[a-z0-9_]+$/.test(name)) throw new Error(`unsafe scratch database name: ${name}`);

  const adminUrl = configuredAdminUrl();
  const admin = new Pool({ connectionString: adminUrl, max: 1 });
  await admin.query(`create database ${name}`);
  await admin.end();

  const url = databaseUrl(adminUrl, name);
  const pool = new Pool({ connectionString: url, max: 24 });

  return {
    name,
    url,
    pool,
    apply(files): void {
      for (const file of files) {
        if (!/^\d{3}_[a-z0-9_]+\.sql$/.test(file)) throw new Error(`unsafe migration filename: ${file}`);
        const result = spawnSync(
          psqlPath(),
          ['--no-psqlrc', '-v', 'ON_ERROR_STOP=1', '-1', '-q', url, '-f', join(MIGRATIONS_DIR, file)],
          { cwd: REPO_ROOT, encoding: 'utf8' },
        );
        if (result.status !== 0) {
          throw new Error(
            `could not apply ${file} to ${name}:\n${result.stdout ?? ''}\n${result.stderr ?? ''}`,
          );
        }
      }
    },
    async query<R extends QueryResultRow = QueryResultRow>(sql: string, params: readonly unknown[] = []): Promise<R[]> {
      const result = await pool.query<R>(sql, [...params]);
      return result.rows;
    },
    async transaction<T>(fn: (client: PoolClient) => Promise<T>): Promise<T> {
      const client = await pool.connect();
      try {
        await client.query('begin');
        const result = await fn(client);
        await client.query('commit');
        return result;
      } catch (error) {
        await client.query('rollback');
        throw error;
      } finally {
        client.release();
      }
    },
    async destroy(): Promise<void> {
      await pool.end();
      const cleanup = new Pool({ connectionString: adminUrl, max: 1 });
      try {
        await cleanup.query(`drop database if exists ${name}`);
      } finally {
        await cleanup.end();
      }
    },
  };
}

