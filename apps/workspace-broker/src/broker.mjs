import { randomUUID } from 'node:crypto';
import { statfs } from 'node:fs/promises';
import { Docker } from './docker.mjs';

const UUID = /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i;
export function validId(value) { if (!UUID.test(value ?? '')) throw new Error('invalid_id'); return value; }
export class KeyedLock {
  tails = new Map();
  async run(key, fn) {
    const previous = this.tails.get(key) ?? Promise.resolve();
    let release;
    const pending = new Promise(resolve => { release = resolve; });
    this.tails.set(key, pending);
    await previous;
    try { return await fn(); }
    finally { release(); if (this.tails.get(key) === pending) this.tails.delete(key); }
  }
}
export class WorkspaceBroker {
  constructor({ machineId, image = 'tm8-workspace:ubuntu24', egressContainer = 'tm8-workspace-egress', docker = new Docker(), stateDir = '/var/lib/tm8-broker' }) {
    this.machineId = validId(machineId); this.image = image; this.egressContainer = egressContainer;
    this.docker = docker; this.stateDir = stateDir; this.locks = new KeyedLock(); this.sessions = new Map();
    this.repositoryContainer = `tm8-repositories-${machineId}`;
  }
  name(workspaceId) { return `tm8-user-${validId(workspaceId)}`; }
  labels(workspaceId, accountId) { return { 'tm8.machine': this.machineId, 'tm8.workspace': validId(workspaceId), 'tm8.account': validId(accountId), 'tm8.kind': 'workspace' }; }
  async checkDisk() {
    const disk = await statfs(this.stateDir);
    if (Number(disk.bavail) / Number(disk.blocks) < 0.15) throw new Error('machine_disk_pressure');
  }
  async provision({ workspaceId, accountId, limits }) {
    validId(workspaceId); validId(accountId);
    if (!limits || !Number.isFinite(limits.cpus) || limits.cpus <= 0 || limits.cpus > 64 ||
        !Number.isInteger(limits.memoryMiB) || limits.memoryMiB < 256 || limits.memoryMiB > 262144 ||
        !Number.isInteger(limits.pids) || limits.pids < 32 || limits.pids > 4096) throw new Error('invalid_limits');
    return this.locks.run(`workspace:${workspaceId}`, async () => {
      const name = this.name(workspaceId), labels = this.labels(workspaceId, accountId);
      let container = await this.docker.inspect(name);
      if (container) this.assertOwner(container, workspaceId, accountId);
      else {
        await this.checkDisk();
        const networkName = `${name}-private`;
        try { await this.docker.request('POST', '/networks/create', { Name: networkName, Internal: true, CheckDuplicate: true, Labels: labels, Options: { 'com.docker.network.bridge.enable_icc': 'true' } }); }
        catch (error) { if (error.status !== 409) throw error; }
        // Only the egress proxy joins this user's network. It has no runtime
        // socket, graph credentials or user volumes and pins public IPv4 DNS.
        try { await this.docker.request('POST', `/networks/${networkName}/connect`, { Container: this.egressContainer, EndpointConfig: { Aliases: ['tm8-egress'] } }); }
        catch (error) { if (error.status !== 403 && !error.message.includes('already exists')) throw error;
          const network = await this.docker.request('GET', `/networks/${networkName}`);
          if (!Object.values(network.Containers ?? {}).some(item => item.Name === this.egressContainer)) throw error;
        }
        const volumeName = `${name}-home`;
        const volume = await this.docker.request('POST', '/volumes/create', { Name: volumeName, Labels: labels });
        if (volume.Labels?.['tm8.workspace'] !== workspaceId || volume.Labels?.['tm8.account'] !== accountId) throw new Error('volume_identity_mismatch');
        await this.docker.request('POST', `/containers/create?name=${name}`, {
          Image: this.image, User: '1000:1000', WorkingDir: '/home/user', Cmd: ['sleep', 'infinity'], Labels: labels,
          Env: ['HOME=/home/user', 'LANG=C.UTF-8', 'HTTP_PROXY=http://tm8-egress:3128', 'HTTPS_PROXY=http://tm8-egress:3128', 'http_proxy=http://tm8-egress:3128', 'https_proxy=http://tm8-egress:3128', 'NO_PROXY=localhost,127.0.0.1'],
          HostConfig: {
            NetworkMode: networkName, ReadonlyRootfs: true, CapDrop: ['ALL'], SecurityOpt: ['no-new-privileges:true'],
            NanoCpus: Math.round(limits.cpus * 1e9), Memory: limits.memoryMiB * 1024 * 1024,
            MemorySwap: limits.memoryMiB * 1024 * 1024, PidsLimit: limits.pids, Init: true,
            RestartPolicy: { Name: 'unless-stopped' },
            Mounts: [{ Type: 'volume', Source: volumeName, Target: '/home/user' }],
            Tmpfs: { '/tmp': 'rw,nosuid,nodev,size=536870912,mode=1777', '/run': 'rw,nosuid,nodev,noexec,size=16777216' },
            LogConfig: { Type: 'local', Config: { 'max-size': '10m', 'max-file': '2' } },
          },
        });
        container = await this.docker.inspect(name);
      }
      if (!container.State.Running) await this.docker.request('POST', `/containers/${name}/start`);
      await this.runner(name, { action: 'home' });
      return { state: 'ready', homePath: '/home/user', workspaceId };
    });
  }
  assertOwner(container, workspaceId, accountId) {
    const labels = container.Config.Labels;
    if (labels?.['tm8.machine'] !== this.machineId || labels?.['tm8.workspace'] !== workspaceId || labels?.['tm8.account'] !== accountId || labels?.['tm8.kind'] !== 'workspace') throw new Error('workspace_identity_mismatch');
  }
  async requireWorkspace(workspaceId, accountId) {
    validId(accountId);
    const name = this.name(workspaceId);
    const container = await this.docker.inspect(name);
    if (!container) throw new Error('workspace_not_provisioned');
    this.assertOwner(container, workspaceId, accountId);
    if (!container.State.Running) throw new Error('workspace_unavailable');
    return name;
  }
  async runner(name, input) {
    const result = await this.docker.exec(name, ['node', '/opt/tm8/runner.mjs'], { input: JSON.stringify(input) });
    let parsed;
    try { parsed = JSON.parse(result.stdout.toString('utf8')); } catch { throw new Error('invalid_runner_response'); }
    if (result.exitCode !== 0 || parsed.error) {
      const error = new Error(parsed.error?.code ?? 'runner_failed'); error.detail = parsed.error?.detail; throw error;
    }
    return parsed.data;
  }
  async repositories() {
    return this.locks.run('repository-store', async () => {
      let container = await this.docker.inspect(this.repositoryContainer);
      const labels = { 'tm8.machine': this.machineId, 'tm8.kind': 'repositories' };
      if (container && (container.Config.Labels?.['tm8.machine'] !== this.machineId || container.Config.Labels?.['tm8.kind'] !== 'repositories')) throw new Error('repository_store_identity_mismatch');
      if (!container) {
        const volumeName = `${this.repositoryContainer}-data`;
        const volume = await this.docker.request('POST', '/volumes/create', { Name: volumeName, Labels: labels });
        if (volume.Labels?.['tm8.machine'] !== this.machineId || volume.Labels?.['tm8.kind'] !== 'repositories') throw new Error('repository_volume_identity_mismatch');
        await this.docker.request('POST', `/containers/create?name=${this.repositoryContainer}`, {
          Image: this.image, User: '1000:1000', Labels: labels, WorkingDir: '/repos', Cmd: ['sleep', 'infinity'],
          HostConfig: { NetworkMode: 'none', ReadonlyRootfs: true, CapDrop: ['ALL'], SecurityOpt: ['no-new-privileges:true'], Init: true,
            Memory: 1073741824, MemorySwap: 1073741824, PidsLimit: 128, NanoCpus: 2e9,
            Mounts: [{ Type: 'volume', Source: volumeName, Target: '/repos' }],
            Tmpfs: { '/tmp': 'rw,nosuid,nodev,size=536870912,mode=1777' }, RestartPolicy: { Name: 'unless-stopped' } },
        });
        container = await this.docker.inspect(this.repositoryContainer);
      }
      if (!container.State.Running) await this.docker.request('POST', `/containers/${this.repositoryContainer}/start`);
      return this.repositoryContainer;
    });
  }
  async operation(input) {
    const name = await this.requireWorkspace(input.workspaceId, input.accountId);
    if (input.action === 'github-credential') return this.runner(name, { action: 'github-credential', token: input.token });
    validId(input.projectId);
    return this.locks.run(`project:${input.projectId}`, async () => {
      const common = { projectId: input.projectId, accountId: input.accountId };
      if (input.action === 'project-create') {
        const result = await this.runner(name, { ...common, action: 'project-create', source: input.source });
        const store = await this.repositories();
        await this.runner(store, { ...common, action: 'repo-init' });
        const bundle = await this.runner(name, { ...common, action: 'git-export' });
        await this.runner(store, { ...common, ...bundle, action: 'repo-push' });
        return result;
      }
      if (input.action === 'checkout-create') {
        const bundle = await this.runner(await this.repositories(), { ...common, action: 'repo-export' });
        return this.runner(name, { ...common, ...bundle, action: 'checkout-create' });
      }
      if (input.action === 'git-sync') {
        if (!['fetch', 'pull', 'push'].includes(input.verb) || !['tm8', 'origin'].includes(input.remote)) throw new Error('invalid_git_action');
        if (input.remote === 'origin') return this.runner(name, { ...common, action: 'git-origin', verb: input.verb, branch: input.branch });
        const store = await this.repositories();
        if (input.verb === 'push') {
          const bundle = await this.runner(name, { ...common, action: 'git-export', branch: input.branch });
          return this.runner(store, { ...common, ...bundle, action: 'repo-push' });
        }
        const bundle = await this.runner(store, { ...common, action: 'repo-export' });
        return this.runner(name, { ...common, ...bundle, action: 'git-import', branch: input.branch, pull: input.verb === 'pull' });
      }
      if (!['files-list', 'files-read', 'files-write', 'git-status', 'git-commit', 'git-connect', 'github-create'].includes(input.action)) throw new Error('unsupported_workspace_action');
      return this.runner(name, { ...common, action: input.action, path: input.path, content: input.content, message: input.message, url: input.url, name: input.name, private: input.private });
    });
  }
  async terminal(input, { id = randomUUID(), argv, credentialProvider, execution, spaceId, onData, onClose } = {}) {
    const name = await this.requireWorkspace(input.workspaceId, input.accountId);
    const cwd = input.projectId ? `/home/user/projects/${validId(input.projectId)}` : '/home/user';
    if (input.command !== undefined && (typeof input.command !== 'string' || input.command.length > 32768)) throw new Error('invalid_command');
    if ([...this.sessions.values()].filter(session => session.workspaceId === input.workspaceId && !session.exited).length >= 20) throw new Error('terminal_limit');
    const command = await this.docker.request('POST', `/containers/${name}/exec`, {
      User: '1000:1000', WorkingDir: cwd, AttachStdin: true, AttachStdout: true, AttachStderr: true, Tty: true,
      Env: ['TERM=xterm-256color'], Cmd: argv ?? (input.command ? ['bash', '-lc', input.command] : ['bash', '-l']),
    });
    const socket = await this.docker.request('POST', `/exec/${command.Id}/start`, { Detach: false, Tty: true, ConsoleSize: [input.rows ?? 24, input.cols ?? 80] }, { hijack: true });
    const session = { id, execId: command.Id, workspaceId: input.workspaceId, accountId: input.accountId, projectId: input.projectId, credentialProvider, execution, spaceId, socket, listeners: new Set(), replay: Buffer.alloc(0), offset: 0, exited: false };
    this.sessions.set(session.id, session);
    socket.on('data', data => { session.offset += data.length; session.replay = Buffer.concat([session.replay, data]).subarray(execution ? -1048576 : -65536); onData?.(session); for (const client of session.listeners) { if (client.bufferedAmount > 1024 * 1024) client.close(1013); else client.send(data); } });
    socket.on('error', () => {});
    socket.on('close', () => { session.exited = true; if (onClose) void onClose(session).catch(() => { for (const client of session.listeners) client.close(1011); }); else for (const client of session.listeners) client.close(1000); if (!credentialProvider && !execution) this.sessions.delete(session.id); });
    return { sessionId: session.id };
  }
  session(sessionId, workspaceId, accountId) {
    const session = this.sessions.get(validId(sessionId));
    if (!session || session.workspaceId !== workspaceId || session.accountId !== accountId) throw new Error('terminal_not_found');
    return session;
  }
}
