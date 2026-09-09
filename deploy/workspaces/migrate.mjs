import * as fs from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import http from 'node:http';
import pg from 'pg';
import { WorkspaceBroker } from '../../apps/workspace-broker/src/broker.mjs';

const exec = promisify(execFile);
const uuid = value => { if (!/^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i.test(value ?? '')) throw new Error('Expected a UUID in the migration manifest'); return value; };
const digest = value => createHash('sha256').update(value).digest('hex');
const git = async (cwd, args) => (await exec('git', ['--no-optional-locks', '-c', 'core.hooksPath=/dev/null', '-c', 'protocol.ext.allow=never', '-C', cwd, ...args], { maxBuffer: 32 * 1024 * 1024, env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } })).stdout.trim();

export async function fingerprint(root) {
  const digest = createHash('sha256');
  async function visit(relative) {
    const location = path.join(root, relative), stat = await fs.lstat(location);
    digest.update(JSON.stringify([relative, stat.mode & 0o777, stat.isSymbolicLink() ? 'link' : stat.isDirectory() ? 'dir' : 'file']));
    if (stat.isSymbolicLink()) digest.update(await fs.readlink(location));
    else if (stat.isDirectory()) {
      for (const name of (await fs.readdir(location)).sort()) if (relative || name !== '.git') await visit(path.join(relative, name));
    } else if (stat.isFile()) for await (const bytes of createReadStream(location)) digest.update(bytes);
    else throw new Error(`Special file requires manual review: ${relative}`);
  }
  await visit('');
  return digest.digest('hex');
}

export async function inspectSource(source) {
  if (!path.isAbsolute(source) || (await fs.lstat(source)).isSymbolicLink()) throw new Error('Source must be an explicit real directory');
  if (!(await fs.stat(source)).isDirectory()) throw new Error('Project source is not a directory');
  let repository = null;
  try {
    const top = await fs.realpath(await git(source, ['rev-parse', '--show-toplevel']));
    if (top !== await fs.realpath(source)) throw new Error('Project is nested in another Git repository; choose its repository root explicitly');
    repository = {
      gitDir: await git(source, ['rev-parse', '--absolute-git-dir']),
      commonDir: await git(source, ['rev-parse', '--path-format=absolute', '--git-common-dir']),
      head: await git(source, ['rev-parse', '--verify', 'HEAD']),
      status: await git(source, ['status', '--porcelain=v1', '--untracked-files=all']),
      index: digest(await git(source, ['ls-files', '--stage'])),
      refs: digest(await git(source, ['for-each-ref', '--format=%(refname):%(objectname)'])),
      branch: await git(source, ['symbolic-ref', '-q', 'HEAD']).catch(() => null),
    };
  } catch (error) {
    if (!String(error.stderr ?? '').includes('not a git repository')) throw error;
  }
  return { fingerprint: await fingerprint(source), repository };
}

/** Copy working files without following links; normalize Git worktrees into a
 * standalone repository while keeping every ref, staged blob and dirty file. */
export async function copySource(source, destination) {
  const before = await inspectSource(source);
  await fs.mkdir(destination, { mode: 0o700 });
  for (const name of await fs.readdir(source)) if (name !== '.git') await fs.cp(path.join(source, name), path.join(destination, name), { recursive: true, dereference: false, verbatimSymlinks: true, preserveTimestamps: true });
  // Directory mode is included in the fingerprint and is restored at the end.
  if (before.repository) {
    await git(destination, ['clone', '--mirror', '--no-hardlinks', '--', source, '.git']);
    await fs.copyFile(path.join(before.repository.commonDir, 'config'), path.join(destination, '.git/config'));
    await git(destination, ['config', '--local', 'core.bare', 'false']);
    await git(destination, ['config', '--local', '--unset-all', 'core.worktree']).catch(() => undefined);
    const index = path.join(before.repository.gitDir, 'index');
    try { await fs.copyFile(index, path.join(destination, '.git/index')); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    // A local mirror preserves unreachable loose objects too. Copy the index's
    // referenced blobs explicitly so this also holds for linked worktrees.
    const staged = await git(source, ['ls-files', '--stage']);
    for (const line of staged.split('\n').filter(Boolean)) {
      const object = /^\d+ ([0-9a-f]+) /.exec(line)?.[1];
      if (!object) throw new Error('Unexpected Git index record');
      await git(destination, ['cat-file', '-e', object]);
    }
    if (await git(destination, ['rev-parse', 'HEAD']) !== before.repository.head ||
        await git(destination, ['status', '--porcelain=v1', '--untracked-files=all']) !== before.repository.status) throw new Error('Copied Git index or history differs from the source');
  }
  await fs.chmod(destination, (await fs.stat(source)).mode & 0o777);
  const after = await inspectSource(source);
  if (after.fingerprint !== before.fingerprint || JSON.stringify(after.repository) !== JSON.stringify(before.repository) || await fingerprint(destination) !== before.fingerprint) throw new Error('Source changed during copy; leave originals intact and retry while quiesced');
  return before;
}

async function transaction(pool, fn) {
  const client = await pool.connect();
  try { await client.query('begin'); const result = await fn(client); await client.query('commit'); return result; }
  catch (error) { await client.query('rollback'); throw error; }
  finally { client.release(); }
}
async function writePrivate(file, value) {
  await fs.writeFile(file, JSON.stringify(value, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
}
export async function inventory(pool) {
  const accounts = (await pool.query('select id,identity_id,username,email,status,is_owner,is_node_admin from public.accounts order by id')).rows;
  const projects = (await pool.query(`select p.id,p.name,p.working_dir,jsonb_agg(distinct sp.space_id) spaces,
    coalesce(jsonb_agg(distinct a.id) filter(where a.id is not null),'[]') candidate_owners
    from public.projects p left join public.space_projects sp on sp.project_id=p.id
    left join public.members m on m.space_id=sp.space_id and m.role='owner'
    left join public.accounts a on a.identity_id=m.identity_id group by p.id order by p.id`)).rows;
  for (const project of projects) {
    try { project.source = await inspectSource(project.working_dir); } catch (error) { project.review = error.code ?? error.message; }
  }
  return { version: 1, accounts, projects, note: 'Supply explicit ownerAccountId and homeSpaceId for every migrated project. Password hashes and session credentials are excluded.' };
}

async function backupDatabase(url, file) {
  const parsed = new URL(url);
  const handle = await fs.open(file, 'wx', 0o600); await handle.close();
  const env = { ...process.env, PGHOST: parsed.hostname, PGPORT: parsed.port || '5432', PGDATABASE: decodeURIComponent(parsed.pathname.slice(1)), PGUSER: decodeURIComponent(parsed.username), PGPASSWORD: decodeURIComponent(parsed.password) };
  if (parsed.searchParams.has('sslmode')) env.PGSSLMODE = parsed.searchParams.get('sslmode');
  await exec(process.env.TM8_PG_DUMP ?? '/usr/lib/postgresql/16/bin/pg_dump', ['--format=custom', '--file', file], { env });
}
async function uploadArchive(docker, container, destination, archive) {
  const length = (await fs.stat(archive)).size;
  await new Promise((resolve, reject) => {
    const request = http.request({ socketPath: docker.socketPath, method: 'PUT', path: `/v1.45/containers/${encodeURIComponent(container)}/archive?path=${encodeURIComponent(destination)}`,
      headers: { 'content-type': 'application/x-tar', 'content-length': length } }, response => {
      response.resume(); response.on('end', () => response.statusCode === 200 ? resolve() : reject(new Error('Docker refused migration archive')));
      response.on('error', reject);
    });
    request.on('error', reject); request.setTimeout(120000, () => request.destroy(new Error('Migration upload timed out')));
    const stream = createReadStream(archive); stream.on('error', error => request.destroy(error)); stream.pipe(request);
  });
}

export async function migrateProjects(pool, manifest, directory, broker, databaseUrl) {
  uuid(manifest.machineId);
  if (!Array.isArray(manifest.projects) || !manifest.projects.length) throw new Error('An explicit project ownership manifest is required');
  const lock = await pool.connect();
  await lock.query("select pg_advisory_lock(hashtext('tm8_workspace_cutover'))");
  try {
    const node = (await pool.query('select * from public.workspace_node where singleton')).rows[0];
    if (node.machine_id !== manifest.machineId) throw new Error('Manifest machine ID does not match this graph database');
    const backup = path.join(directory, `graph-${randomUUID()}.dump`); await backupDatabase(databaseUrl, backup);
    for (const entry of manifest.projects) {
      for (const key of ['projectId', 'ownerAccountId', 'homeSpaceId']) uuid(entry[key]);
      const project = (await pool.query(`select p.* from public.projects p join public.space_projects sp on sp.project_id=p.id
        join public.members m on m.space_id=sp.space_id join public.accounts a on a.identity_id=m.identity_id
        where p.id=$1 and sp.space_id=$2 and a.id=$3 and a.status='active'`, [entry.projectId, entry.homeSpaceId, entry.ownerAccountId])).rows[0];
      if (!project) throw new Error('Project, account and space membership must already exist; graph identities are never recreated');
      const source = entry.sourcePath ?? project.working_dir;
      const prior = (await pool.query('select * from public.workspace_migration_ledger where project_id=$1', [entry.projectId])).rows[0];
      if (prior && (prior.account_id !== entry.ownerAccountId || prior.home_space_id !== entry.homeSpaceId || (entry.sourcePath && prior.source_path !== entry.sourcePath))) throw new Error('Migration ownership changed; explicit operator reconciliation is required');
      if (prior?.state === 'ready') { process.stdout.write(`Already migrated project ${entry.projectId}\n`); continue; }
      const work = path.join(directory, `copy-${randomUUID()}`);
      const snapshot = await copySource(prior?.source_path ?? source, work);
      const sourceFingerprint = digest(JSON.stringify(snapshot));
      if (prior && prior.source_fingerprint !== sourceFingerprint) throw new Error('Source changed since the interrupted migration; review it before resuming');
      const workspace = await transaction(pool, async client => {
        await client.query('select * from public.workspace_node where singleton for update');
        let row = (await client.query('select * from public.user_workspaces where account_id=$1 for update', [entry.ownerAccountId])).rows[0];
        if (row && (row.machine_id !== manifest.machineId || row.state === 'suspended')) throw new Error('Workspace assignment is incompatible');
        if (!row) {
          if (Number((await client.query('select count(*) n from public.user_workspaces')).rows[0].n) >= node.capacity) throw new Error('Workspace capacity exhausted');
          row = (await client.query(`insert into public.user_workspaces(account_id,machine_id,limits) values($1,$2,$3) returning *`, [entry.ownerAccountId, manifest.machineId, node.limits])).rows[0];
        }
        return row;
      });
      const operation = prior?.operation_id ?? randomUUID();
      await pool.query(`insert into public.workspace_migration_ledger(project_id,operation_id,workspace_id,account_id,home_space_id,original_working_dir,source_path,source_fingerprint,state,backup_path)
        values($1,$2,$3,$4,$5,$6,$7,$8,'copying',$9) on conflict do nothing`, [project.id, operation, workspace.id, entry.ownerAccountId, entry.homeSpaceId, project.working_dir, source, sourceFingerprint, backup]);
      await broker.provision({ workspaceId: workspace.id, accountId: entry.ownerAccountId, limits: workspace.limits });
      const container = await broker.requireWorkspace(workspace.id, entry.ownerAccountId);
      const destination = `/home/user/migrations/${operation}`;
      const mkdir = await broker.docker.exec(container, ['mkdir', '-p', destination]);
      if (mkdir.exitCode) throw new Error('Cannot prepare private migration directory');
      const archive = path.join(directory, `copy-${operation}.tar`);
      await exec('tar', ['--owner=1000', '--group=1000', '-C', work, '-cf', archive, '.']);
      await fs.chmod(archive, 0o600); await uploadArchive(broker.docker, container, destination, archive);
      await broker.operation({ action: 'project-create', workspaceId: workspace.id, accountId: entry.ownerAccountId, projectId: project.id, source: { kind: 'import', relativePath: `migrations/${operation}` } });
      if (digest(JSON.stringify(await inspectSource(prior?.source_path ?? source))) !== sourceFingerprint) throw new Error('Original files changed before cutover; all copies have been retained');
      // Only after the complete copy and Git publication do graph paths change.
      await transaction(pool, async client => {
        await client.query(`insert into public.workspace_repositories(project_id,home_space_id,owner_account_id,state,source,client_mutation_id)
          values($1,$2,$3,'ready',$4,$5)`, [project.id, entry.homeSpaceId, entry.ownerAccountId, { kind: 'import', relativePath: `migrations/${operation}` }, `migration:${operation}`]);
        await client.query(`insert into public.workspace_checkouts(workspace_id,project_id,relative_path,state) values($1,$2,$3,'ready')`, [workspace.id, project.id, `projects/${project.id}`]);
        await client.query('update public.projects set working_dir=$2 where id=$1', [project.id, `/home/user/projects/${project.id}`]);
        await client.query("update public.user_workspaces set state='ready',updated_at=now(),failure_code=null where id=$1", [workspace.id]);
        await client.query("update public.workspace_migration_ledger set state='ready',completed_at=now() where project_id=$1", [project.id]);
      });
      process.stdout.write(`Migrated project ${project.id}; original files retained\n`);
    }
  } finally { await lock.query("select pg_advisory_unlock(hashtext('tm8_workspace_cutover'))"); lock.release(); }
}

async function main() {
  const args = process.argv.slice(2), command = args.shift();
  const value = name => { const index = args.indexOf(name); return index < 0 ? undefined : args[index + 1]; };
  if (!process.env.TM8_MIGRATION_DATABASE_URL) throw new Error('TM8_MIGRATION_DATABASE_URL must be a privileged operator connection');
  const pool = new pg.Pool({ connectionString: process.env.TM8_MIGRATION_DATABASE_URL });
  try {
    const output = path.resolve(value('--out') ?? '.tm8-migrations');
    if (command === 'inventory') await writePrivate(output, await inventory(pool));
    else if (command === 'export-directory') {
      const machine = (await pool.query('select machine_id from public.workspace_node where singleton')).rows[0];
      const accounts = (await pool.query(`select a.id,a.identity_id "identityId",a.email,w.id "workspaceId",w.operation_id "operationId"
        from public.accounts a left join public.user_workspaces w on w.account_id=a.id where a.status='active' order by a.id`)).rows;
      for (const account of accounts) {
        if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(account.email ?? '')) throw new Error(`Account ${account.id} needs an explicit verified-email migration mapping`);
        account.workspaceId ??= randomUUID(); account.operationId ??= randomUUID();
      }
      await writePrivate(output, { version: 1, machineId: machine.machine_id, accounts });
    }
    else if (command === 'migrate') {
      if (!args.includes('--quiesced') || !value('--manifest')) throw new Error('Stop tm8 and user execution, then pass --quiesced and --manifest');
      await fs.mkdir(output, { recursive: true, mode: 0o700 }); await fs.chmod(output, 0o700);
      const manifest = JSON.parse(await fs.readFile(value('--manifest'), 'utf8'));
      await fs.mkdir('/var/lib/tm8-broker', { recursive: true });
      const broker = new WorkspaceBroker({ machineId: manifest.machineId, image: process.env.TM8_RUNNER_IMAGE, egressContainer: process.env.TM8_EGRESS_CONTAINER });
      await migrateProjects(pool, manifest, output, broker, process.env.TM8_MIGRATION_DATABASE_URL);
    } else throw new Error('Use inventory/export-directory --out FILE or migrate --manifest FILE --out DIRECTORY --quiesced');
  } finally { await pool.end(); }
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().catch(error => { process.stderr.write(`Migration stopped: ${error.message}\n`); process.exitCode = 1; });
}
