import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import path from 'node:path';
import pg from 'pg';

const uuid = value => /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i.test(value ?? '');
/** Explicit operator import. It never carries password hashes, session tokens
 * or an inferred Supabase identity across the boundary. */
export async function importDirectory(pool, manifest) {
  if (manifest.version !== 1 || !uuid(manifest.machineId) || !Array.isArray(manifest.accounts)) throw new Error('Invalid directory manifest');
  const client = await pool.connect();
  try {
    await client.query('begin');
    const machine = (await client.query('select * from tm8_directory.machines where id=$1 for update', [manifest.machineId])).rows[0];
    if (!machine) throw new Error('Register the existing machine ID before importing its directory');
    for (const entry of manifest.accounts) {
      if (![entry.id, entry.workspaceId, entry.operationId].every(uuid) || typeof entry.identityId !== 'string' || !entry.identityId || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(entry.email ?? '')) throw new Error('Account requires an explicit ID, identity and email mapping');
      const existing = (await client.query('select * from tm8_directory.accounts where id=$1 for update', [entry.id])).rows[0];
      if (existing && (existing.identity_id !== entry.identityId || existing.email.toLowerCase() !== entry.email.toLowerCase())) throw new Error('Existing account mapping conflicts; no email merge was performed');
      if (!existing) await client.query('insert into tm8_directory.accounts(id,identity_id,email) values($1,$2,$3)', [entry.id, entry.identityId, entry.email.toLowerCase()]);
      const assigned = (await client.query('select * from tm8_directory.assignments where account_id=$1', [entry.id])).rows[0];
      if (assigned) {
        if (assigned.machine_id !== manifest.machineId || assigned.workspace_id !== entry.workspaceId || assigned.operation_id !== entry.operationId) throw new Error('Existing workspace mapping conflicts');
      } else {
        const updated = await client.query('update tm8_directory.machines set allocated=allocated+1 where id=$1 and allocated<capacity', [manifest.machineId]);
        if (!updated.rowCount) throw new Error('Increase the registered machine capacity before importing its existing users');
        await client.query('insert into tm8_directory.assignments(account_id,machine_id,workspace_id,operation_id) values($1,$2,$3,$4)', [entry.id, manifest.machineId, entry.workspaceId, entry.operationId]);
      }
    }
    await client.query('commit');
  } catch (error) { await client.query('rollback'); throw error; }
  finally { client.release(); }
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  if (!process.env.TM8_CONTROL_DATABASE_URL || !process.argv[2]) throw new Error('Set TM8_CONTROL_DATABASE_URL and pass the reviewed directory manifest');
  const pool = new pg.Pool({ connectionString: process.env.TM8_CONTROL_DATABASE_URL });
  try { await importDirectory(pool, JSON.parse(await readFile(process.argv[2], 'utf8'))); process.stdout.write('Directory imported. Issue invitations for verified email enrollment; existing passwords were not transferred.\n'); }
  finally { await pool.end(); }
}
