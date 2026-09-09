import { describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import * as fs from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createDb } from '../../src/db/client.js';
import { createW1ScratchDatabase, migrationFiles } from '../db/w1-pg.js';
import { WorkspaceBroker } from '../../../../apps/workspace-broker/src/broker.mjs';
import { fingerprint, migrateProjects } from '../../../../deploy/workspaces/migrate.mjs';
const exec = promisify(execFile);
vi.setConfig({ testTimeout: 180000 });
describe.skipIf(process.env.TM8_TEST_DOCKER !== '1')('operator project migration with real Docker and PostgreSQL', () => {
  it('preserves graph IDs and dirty code, refuses changed ownership, and resumes without recopying', async () => {
    const database = await createW1ScratchDatabase('migration'); database.apply(migrationFiles());
    const dir = await fs.mkdtemp(path.join(tmpdir(), 'tm8-cutover-'));
    const machineId = randomUUID(), projectId = randomUUID(), identityId = randomUUID();
    const broker = new WorkspaceBroker({ machineId, stateDir: dir });
    const db = createDb(database.url); let workspaceId: string | undefined;
    try {
      const account = await db.rpc<{ id: string }>({}, 'ensure_account', [identityId, 'migration-owner', 'Owner', 'owner@example.test', true, true, 'scrypt', 'unmatchable']);
      const claims = { identityId, nodeAdmin: true, authKind: 'browser' };
      await db.rpc(claims, 'configure_workspace_limits', [machineId, 10, JSON.stringify({ cpus: 1, memoryMiB: 512, pids: 64 })]);
      const space = await db.rpc<{ space: { id: string } }>(claims, 'create_space', ['Existing space', '', 'private', null, randomUUID()]);
      const source = path.join(dir, 'original'); await fs.mkdir(source);
      const git = async (...args: string[]) => (await exec('git', ['-C', source, ...args])).stdout.trim();
      await git('init', '-b', 'main'); await git('config', 'user.name', 'Fixture'); await git('config', 'user.email', 'fixture@example.test');
      await fs.writeFile(path.join(source, 'README.md'), 'committed'); await git('add', '.'); await git('commit', '-m', 'original');
      await fs.writeFile(path.join(source, 'README.md'), 'private dirty edits'); await fs.writeFile(path.join(source, 'untracked'), 'private');
      await database.query('insert into public.projects(id,name,working_dir) values($1,$2,$3)', [projectId, 'Existing project', source]);
      await database.query('insert into public.space_projects(space_id,project_id) values($1,$2)', [space.space.id, projectId]);
      const original = await fingerprint(source), commits = await git('rev-parse', 'HEAD');
      const manifest = { machineId, projects: [{ projectId, ownerAccountId: account.id, homeSpaceId: space.space.id, sourcePath: source }] };
      const backups = path.join(dir, 'backups'); await fs.mkdir(backups);
      await migrateProjects(database.pool, manifest, backups, broker, database.url);
      const ledger = (await database.query('select * from public.workspace_migration_ledger where project_id=$1', [projectId]))[0]!;
      workspaceId = ledger.workspace_id as string;
      expect(ledger.state).toBe('ready'); expect(ledger.original_working_dir).toBe(source);
      expect(await fingerprint(source)).toBe(original);
      const container = broker.name(workspaceId);
      const result = await broker.docker.exec(container, ['git', '-C', `/home/user/projects/${projectId}`, 'rev-parse', 'HEAD']);
      expect(result.stdout.toString().trim()).toBe(commits);
      const file = await broker.operation({ action: 'files-read', accountId: account.id, workspaceId, projectId, path: 'README.md' });
      expect(Buffer.from(file.content, 'base64').toString()).toBe('private dirty edits');
      await migrateProjects(database.pool, manifest, backups, broker, database.url);
      expect((await database.query('select count(*)::int n from public.user_workspaces'))[0]!.n).toBe(1);
      expect((await database.query('select project_id from public.space_projects where space_id=$1', [space.space.id]))[0]!.project_id).toBe(projectId);
      await expect(migrateProjects(database.pool, { machineId, projects: [{ ...manifest.projects[0], ownerAccountId: randomUUID() }] }, backups, broker, database.url)).rejects.toThrow();
    } finally {
      if (!workspaceId) workspaceId = (await database.query('select id from public.user_workspaces limit 1'))[0]?.id as string | undefined;
      if (workspaceId) {
        const name = broker.name(workspaceId);
        if (await broker.docker.inspect(name)) await broker.docker.request('DELETE', `/containers/${name}?force=true`);
        await broker.docker.request('POST', `/networks/${name}-private/disconnect`, { Container: broker.egressContainer, Force: true }).catch(() => undefined);
        await broker.docker.request('DELETE', `/networks/${name}-private`).catch(() => undefined);
        await broker.docker.request('DELETE', `/volumes/${name}-home`).catch(() => undefined);
      }
      if (await broker.docker.inspect(broker.repositoryContainer)) await broker.docker.request('DELETE', `/containers/${broker.repositoryContainer}?force=true`);
      await broker.docker.request('DELETE', `/volumes/${broker.repositoryContainer}-data`).catch(() => undefined);
      await db.end(); await database.destroy(); await fs.rm(dir, { recursive: true, force: true });
    }
  });
});
