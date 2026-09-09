import * as fs from 'node:fs/promises';
import path from 'node:path';
import { validId, KeyedLock } from './broker.mjs';

/** Broker-owned process records contain identifiers and bounded terminal
 * replay, never provider credentials. They survive app and broker restarts. */
export class WorkspaceExecution {
  constructor(broker) {
    this.broker = broker; this.records = new Map(); this.locks = new KeyedLock();
    this.dir = path.join(broker.stateDir, 'execution', broker.machineId);
  }
  async init() {
    await fs.mkdir(this.dir, { recursive: true, mode: 0o700 });
    for (const file of await fs.readdir(this.dir)) {
      if (!/^[a-f0-9-]{36}\.json$/.test(file)) continue;
      const record = JSON.parse(await fs.readFile(path.join(this.dir, file), 'utf8'));
      validId(record.sessionId); validId(record.workspaceId); validId(record.accountId);
      this.records.set(record.sessionId, record);
      if (!record.exited) {
        // Docker cannot reattach an already-started exec. Stop its exact
        // process group before recording an interrupted run, never a ghost.
        const container = await this.broker.docker.inspect(this.broker.name(record.workspaceId));
        if (container) {
          this.broker.assertOwner(container, record.workspaceId, record.accountId);
          if (container.State.Running) await this.broker.runner(this.broker.name(record.workspaceId), { action: 'execution-stop', sessionId: record.sessionId });
        }
        record.exited = true; record.exitCode = 137; record.reason = 'broker_restart'; record.acknowledged = false;
        await this.persist(record);
      }
      this.restore(record);
    }
  }
  restore(record) {
    this.broker.sessions.set(record.sessionId, { id: record.sessionId, workspaceId: record.workspaceId,
      accountId: record.accountId, projectId: record.projectId, execution: true, spaceId: record.spaceId,
      exited: true, exitCode: record.exitCode, replay: Buffer.from(record.replay ?? '', 'base64'),
      offset: record.offset ?? 0, listeners: new Set(), socket: { destroy() {} } });
  }
  async persist(record) {
    return this.locks.run(`write:${record.sessionId}`, async () => {
      const session = this.broker.sessions.get(record.sessionId);
      if (session) { record.replay = session.replay.toString('base64'); record.offset = session.offset; }
      const file = path.join(this.dir, `${validId(record.sessionId)}.json`);
      await fs.writeFile(`${file}.tmp`, JSON.stringify(record), { mode: 0o600 });
      await fs.rename(`${file}.tmp`, file);
    });
  }
  summary(record) {
    const { sessionId, workspaceId, accountId, identityId, spaceId, exited, exitCode, reason, cwd, branch } = record;
    return { sessionId, workspaceId, accountId, identityId, spaceId, exited, exitCode, reason, cwd, branch };
  }
  async request(input) {
    // Only the tm8 service can access this Unix socket. Lifecycle recovery
    // reads identifiers here; no HTTP operation exposes the all-user list.
    if (input.action === 'pending') return [...this.records.values()].filter(r => r.exited && !r.acknowledged).map(r => this.summary(r));
    const name = await this.broker.requireWorkspace(input.workspaceId, input.accountId);
    const sessionId = validId(input.sessionId);
    return this.locks.run(sessionId, async () => {
      let record = this.records.get(sessionId);
      if (record && (record.workspaceId !== input.workspaceId || record.accountId !== input.accountId)) throw new Error('execution_not_found');
      if (input.action === 'start') {
        if (record) return this.summary(record);
        validId(input.spaceId);
        if (typeof input.identityId !== 'string' || !input.identityId || input.identityId.length > 256) throw new Error('invalid_identity');
        const provider = input.agentTool === 'claude-code' ? 'anthropic' : input.agentTool === 'codex' ? 'openai' : null;
        if (!provider) throw new Error('unsupported_agent_tool');
        const probe = await this.broker.runner(name, { action: 'provider-probe', provider });
        if (!probe.connected) throw new Error('provider_not_connected');
        const prepare = () => this.broker.runner(name, { ...input, action: 'execution-prepare' });
        const prepared = await this.broker.locks.run(`workspace-preferences:${input.workspaceId}`, () =>
          input.projectId ? this.broker.locks.run(`project:${validId(input.projectId)}`, prepare) : prepare());
        record = { sessionId, workspaceId: input.workspaceId, accountId: input.accountId, identityId: input.identityId,
          spaceId: input.spaceId, projectId: input.projectId ?? null, ...prepared, exited: false, exitCode: null, reason: null, acknowledged: false };
        this.records.set(sessionId, record);
        await this.persist(record);
        try {
          let dirty = false;
          const timer = setInterval(() => { if (dirty) { dirty = false; void this.persist(record).catch(() => {}); } }, 1000);
          timer.unref();
          await this.broker.terminal(input, { id: sessionId, execution: true, spaceId: input.spaceId,
            argv: ['/usr/local/bin/node', '/opt/tm8/execution-run.mjs', sessionId],
            onData: () => { dirty = true; },
            onClose: async session => {
              clearInterval(timer);
              let status;
              try { status = await this.broker.docker.request('GET', `/exec/${session.execId}/json`); } catch {}
              if (status?.Running) {
                record.reason ??= 'broker_restart';
                await this.broker.runner(name, { action: 'execution-stop', sessionId });
                status = { ExitCode: 137 };
              }
              record.exited = true; record.exitCode = status?.ExitCode ?? 137;
              session.exitCode = record.exitCode;
              await this.persist(record);
              for (const client of session.listeners) { client.send(JSON.stringify({ type: 'exit', exitCode: record.exitCode })); client.close(1000); }
            },
          });
          await this.broker.runner(name, { action: 'execution-ready', sessionId });
        } catch (error) {
          await this.broker.runner(name, { action: 'execution-stop', sessionId });
          record.exited = true; record.exitCode = 1; record.reason = 'start_failed'; await this.persist(record); throw error;
        }
        return this.summary(record);
      }
      if (!record) {
        if (input.action === 'status') return { sessionId, missing: true };
        throw new Error('execution_not_found');
      }
      if (input.action === 'stop' && !record.exited) {
        record.reason = 'stopped_by_operator';
        await this.broker.runner(name, { action: 'execution-stop', sessionId });
        // Wait for the exec's actual exit, not just acceptance of a signal.
        for (let i = 0; i < 100 && !record.exited; i++) await new Promise(resolve => setTimeout(resolve, 50));
        if (!record.exited) throw new Error('execution_stop_pending');
      } else if (input.action === 'acknowledge') { record.acknowledged = true; await this.persist(record); }
      else if (!['status', 'stop'].includes(input.action)) throw new Error('unsupported_execution_action');
      return this.summary(record);
    });
  }
}
