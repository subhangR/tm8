import { execFile } from 'node:child_process';
import * as fs from 'node:fs/promises';
import { promisify } from 'node:util';
const exec = promisify(execFile);

export const PROVIDERS = Object.freeze({
  anthropic: { binary: '/usr/local/bin/claude', login: ['auth', 'login'], status: ['auth', 'status'], logout: ['auth', 'logout'], credential: '/home/user/.claude/.credentials.json' },
  openai: { binary: '/usr/local/bin/codex', login: ['login', '--device-auth'], status: ['login', 'status'], logout: ['logout'], credential: '/home/user/.codex/auth.json' },
});
export function providerConfig(provider) {
  if (!Object.hasOwn(PROVIDERS, provider)) throw new Error('provider_not_available');
  return PROVIDERS[provider];
}
export function loginFile(sessionId) {
  if (!/^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i.test(sessionId ?? '')) throw new Error('invalid_login_session');
  return `/home/user/.config/tm8/login-${sessionId}.json`;
}
export function parseProviderStatus(provider, result) {
  const base = { provider, connected: false, login: null, authMethod: null, status: 'stale', connectedAt: null, lastVerifiedAt: null };
  if (result.code === 'ENOENT') return { ...base, status: 'unavailable' };
  if (result.killed || result.signal) return base;
  if (provider === 'anthropic') {
    let data;
    try { data = JSON.parse(result.stdout); } catch { return base; }
    if (typeof data.loggedIn !== 'boolean') return base;
    return { ...base, connected: data.loggedIn, status: data.loggedIn ? 'active' : 'revoked',
      login: data.loggedIn && typeof data.email === 'string' ? data.email.slice(0, 320) : null,
      authMethod: data.loggedIn && typeof data.authMethod === 'string' ? data.authMethod.slice(0, 100) : null,
      lastVerifiedAt: new Date().toISOString() };
  }
  // Codex writes status to stderr. Never return its raw output: API-key
  // status can include a portion of the key.
  const text = `${result.stdout ?? ''}\n${result.stderr ?? ''}`;
  if (result.code === 0 && /Logged in using (ChatGPT|an API key)/i.test(text)) {
    return { ...base, connected: true, status: 'active', authMethod: /using ChatGPT/i.test(text) ? 'chatgpt' : 'api_key', lastVerifiedAt: new Date().toISOString() };
  }
  if (/^Not logged in\s*$/im.test(text)) return { ...base, status: 'revoked', lastVerifiedAt: new Date().toISOString() };
  return base;
}
export async function probeProvider(provider) {
  const config = providerConfig(provider);
  let result;
  try { result = { ...await exec(config.binary, config.status, { cwd: '/home/user', timeout: 20000, maxBuffer: 65536 }), code: 0 }; }
  catch (error) { result = error; }
  return parseProviderStatus(provider, result);
}
export async function providerOperation(input) {
  if (input.action === 'provider-ready') {
    const file = loginFile(input.sessionId);
    for (let attempt = 0; attempt < 100; attempt++) {
      try { await fs.access(file); return { ready: true }; } catch (error) { if (error.code !== 'ENOENT') throw error; }
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    throw new Error('provider_start_timed_out');
  }
  if (input.action === 'providers-status') {
    const supported = await Promise.all(Object.keys(PROVIDERS).map(probeProvider));
    const unavailable = ['github', 'gemini', 'hermes', 'cursor'].map(provider => ({ provider, connected: false, login: null, authMethod: null, status: 'unavailable', connectedAt: null, lastVerifiedAt: null }));
    return { providers: [...supported, ...unavailable], gitCredentialStore: 'present' };
  }
  if (input.action === 'provider-stop') {
    const file = loginFile(input.sessionId);
    let state;
    try { state = JSON.parse(await fs.readFile(file, 'utf8')); } catch (error) { if (error.code === 'ENOENT') return { terminated: true }; throw error; }
    if (!Number.isInteger(state.pid) || state.pid < 2) throw new Error('invalid_login_process');
    if (!state.finished) try { process.kill(-state.pid, 'SIGKILL'); } catch (error) { if (error.code !== 'ESRCH') throw error; }
    await fs.rm(file, { force: true });
    return { terminated: true };
  }
  const config = providerConfig(input.provider);
  if (input.action === 'provider-probe') {
    const probe = await probeProvider(input.provider);
    let stored = false;
    if (probe.connected) try { stored = (await fs.stat(config.credential)).size > 0; } catch {}
    return { ...probe, stored };
  }
  if (input.action === 'provider-disconnect') {
    try { await exec(config.binary, config.logout, { cwd: '/home/user', timeout: 20000, maxBuffer: 65536 }); }
    catch { throw new Error('provider_logout_failed'); }
    const result = await probeProvider(input.provider);
    if (result.connected || result.status === 'stale') throw new Error('provider_logout_not_confirmed');
    return { revoked: true };
  }
  throw new Error('unsupported_provider_action');
}
