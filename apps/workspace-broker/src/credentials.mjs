import { randomUUID } from 'node:crypto';

const COMMANDS = Object.freeze({ anthropic: 'claude auth login', openai: 'codex login --device-auth' });
export class WorkspaceCredentials {
  constructor(broker) { this.broker = broker; this.logins = new Map(); }
  async request(input) {
    const name = await this.broker.requireWorkspace(input.workspaceId, input.accountId);
    if (input.action === 'status') return this.broker.runner(name, { action: 'providers-status' });
    return this.broker.locks.run(`credentials:${input.workspaceId}`, async () => {
      if (input.action === 'finish') {
        const login = this.ownedLogin(input);
        await this.stop(login, name);
        const probe = await this.broker.runner(name, { action: 'provider-probe', provider: login.provider });
        return { workSessionId: login.id, provider: login.provider, connected: probe.connected, login: probe.login,
          authMethod: probe.authMethod, status: probe.status === 'active' ? 'active' : probe.status === 'revoked' ? 'revoked' : 'stale',
          stored: probe.stored === true, terminated: true };
      }
      if (!Object.hasOwn(COMMANDS, input.provider)) throw new Error('provider_not_available');
      if (input.action === 'start') {
        const existing = [...this.logins.values()].find(login => login.workspaceId === input.workspaceId);
        if (existing?.provider === input.provider) return { workSessionId: existing.id, provider: existing.provider, command: COMMANDS[existing.provider], expiresAt: existing.expiresAt };
        if (existing) await this.stop(existing, name);
        const probe = await this.broker.runner(name, { action: 'provider-probe', provider: input.provider });
        if (probe.status === 'unavailable') throw new Error('provider_not_installed_in_workspace');
        const id = randomUUID();
        const login = { id, provider: input.provider, workspaceId: input.workspaceId, accountId: input.accountId, expiresAt: new Date(Date.now() + 600000).toISOString() };
        await this.broker.terminal(input, { id, credentialProvider: input.provider, argv: ['node', '/opt/tm8/provider-login.mjs', input.provider, id] });
        try { await this.broker.runner(name, { action: 'provider-ready', sessionId: id }); }
        catch (error) { await this.stop(login, name); throw error; }
        login.timer = setTimeout(() => {
          void this.broker.locks.run(`credentials:${input.workspaceId}`, () => this.stop(login, name)).catch(() => {});
        }, 600000);
        login.timer.unref(); this.logins.set(id, login);
        return { workSessionId: id, provider: input.provider, command: COMMANDS[input.provider], expiresAt: login.expiresAt };
      }
      if (input.action === 'disconnect') {
        const result = { provider: input.provider, revoked: false, terminatedCredentialSessionIds: [], terminatedAgentSessionIds: [], failures: [] };
        // An arbitrary shell may have started a provider too. Restart this
        // owner's runner so none of those processes can restore a login after
        // logout. The persistent home and project files are preserved.
        const sessions = [...this.broker.sessions.values()].filter(session => session.workspaceId === input.workspaceId);
        await this.broker.docker.request('POST', `/containers/${name}/restart?t=2`);
        for (const session of sessions) {
          (session.credentialProvider ? result.terminatedCredentialSessionIds : result.terminatedAgentSessionIds).push(session.id);
          this.closeSession(session.id);
        }
        for (const login of this.logins.values()) if (login.workspaceId === input.workspaceId) { clearTimeout(login.timer); this.logins.delete(login.id); }
        try { await this.broker.runner(name, { action: 'provider-disconnect', provider: input.provider }); result.revoked = true; }
        catch { result.failures.push({ step: 'revoke', reason: 'Provider logout could not be confirmed. Retry disconnect.' }); }
        return result;
      }
      throw new Error('unsupported_credential_action');
    });
  }
  ownedLogin(input) {
    const login = this.logins.get(input.sessionId);
    if (!login || login.accountId !== input.accountId || login.workspaceId !== input.workspaceId) throw new Error('credential_session_not_found');
    return login;
  }
  closeSession(id) {
    const session = this.broker.sessions.get(id);
    if (!session) return;
    for (const client of session.listeners) client.close(1000);
    session.socket.destroy(); if (!session.execution) this.broker.sessions.delete(id);
  }
  async stop(login, name) {
    await this.broker.runner(name, { action: 'provider-stop', sessionId: login.id });
    this.closeSession(login.id); clearTimeout(login.timer); this.logins.delete(login.id);
  }
}
