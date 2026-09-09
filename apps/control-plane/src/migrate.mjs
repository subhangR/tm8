import { createHash, randomUUID } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import pg from 'pg';
import { hash, secret } from './directory.mjs';

export async function migrate(pool) {
  const client = await pool.connect();
  try {
    await client.query("select pg_advisory_lock(hashtext('tm8_control_migrations'))");
    await client.query('create table if not exists public.tm8_control_migrations(name text primary key, checksum text not null, applied_at timestamptz not null default now())');
    const dir = new URL('../migrations/', import.meta.url);
    for (const name of (await readdir(dir)).filter(name => /^\d{3}_.*\.sql$/.test(name)).sort()) {
      const sql = await readFile(new URL(name, dir), 'utf8');
      const checksum = createHash('sha256').update(sql).digest('hex');
      const applied = await client.query('select checksum from public.tm8_control_migrations where name=$1', [name]);
      if (applied.rows[0]) {
        if (applied.rows[0].checksum !== checksum) throw new Error(`Migration checksum mismatch: ${name}`);
        continue;
      }
      await client.query('begin');
      try {
        await client.query(sql);
        await client.query('insert into public.tm8_control_migrations(name,checksum) values($1,$2)', [name, checksum]);
        await client.query('commit');
      } catch (error) { await client.query('rollback'); throw error; }
    }
  } finally {
    await client.query("select pg_advisory_unlock(hashtext('tm8_control_migrations'))");
    client.release();
  }
}

/** Explicit operator ceremony; creates an invitation, never an authenticated session. */
export async function bootstrapAdmin(pool, email) {
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email ?? '')) throw new Error('A valid administrator email is required');
  const client = await pool.connect();
  try {
    await client.query('begin');
    await client.query('lock table tm8_directory.accounts in exclusive mode');
    if ((await client.query('select 1 from tm8_directory.accounts where is_admin')).rowCount) throw new Error('An administrator already exists');
    const id = randomUUID(); const code = secret();
    await client.query('insert into tm8_directory.accounts(id,identity_id,email,is_admin) values($1,$2,$3,true)', [id, randomUUID(), email.toLowerCase()]);
    await client.query(`insert into tm8_directory.invitations(id,account_id,code_hash,created_by,expires_at)
      values($1,$2,$3,$2,now()+interval '1 day')`, [randomUUID(), id, hash(code)]);
    await client.query('commit');
    return code;
  } catch (error) { await client.query('rollback'); throw error; }
  finally { client.release(); }
}

if (process.argv[1] && import.meta.url === new URL(process.argv[1], 'file:').href) {
  if (!process.env.TM8_CONTROL_DATABASE_URL) throw new Error('TM8_CONTROL_DATABASE_URL is required');
  const pool = new pg.Pool({ connectionString: process.env.TM8_CONTROL_DATABASE_URL });
  try {
    await migrate(pool);
    if (process.argv[2] === 'bootstrap-admin') {
      const code = await bootstrapAdmin(pool, process.argv[3]);
      process.stdout.write(`First-administrator invitation (expires in 24 hours): ${code}\n`);
    } else process.stdout.write('Control directory migrations applied.\n');
  } finally { await pool.end(); }
}
