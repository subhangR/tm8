// probeNodeAgentLogin — the one answer for the pre-spawn refusal (E12) and
// Node admin's "node has a usable claude/codex login" row. A refusal must rest
// on a definite "no"; anything the probe cannot read is `unknown`.

import { describe, expect, it } from 'vitest';
import type { CommandRunner, CredentialBinaryResolver } from '../../src/facade/services/w2/credential-probe.js';
import { probeNodeAgentLogin } from '../../src/facade/services/w2/credential-probe.js';

const present: CredentialBinaryResolver = ({ binary }) => `/usr/local/bin/${binary}`;
const absent: CredentialBinaryResolver = () => null;
const answers = (stdout: string, exitCode = 0): CommandRunner => async () => ({ exitCode, stdout, stderr: '' });
const env = { HOME: '/home/tm8', USER: 'tm8', PATH: '/usr/bin' };

describe('probeNodeAgentLogin', () => {
  it('reads a confirmed claude login as usable, as the node user', async () => {
    const status = await probeNodeAgentLogin({
      provider: 'anthropic', env, cwd: '/', resolveBinary: present,
      run: answers('{"loggedIn":true,"authMethod":"claude.ai","email":"ops@example.com"}'),
    });
    expect(status).toMatchObject({ verdict: 'usable', binary: 'claude', runAs: 'tm8', home: '/home/tm8', login: 'ops@example.com' });
  });

  it('reads loggedIn=false as missing, with the fix as that user', async () => {
    const status = await probeNodeAgentLogin({
      provider: 'anthropic', env, cwd: '/', resolveBinary: present, run: answers('{"loggedIn":false}', 1),
    });
    expect(status.verdict).toBe('missing');
    expect(status.fix).toContain('claude auth login');
    expect(status.fix).toContain('tm8');
  });

  it('reads an absent CLI as missing', async () => {
    const status = await probeNodeAgentLogin({ provider: 'openai', env, cwd: '/', resolveBinary: absent, run: answers('') });
    expect(status).toMatchObject({ verdict: 'missing', binary: 'codex' });
  });

  it('reads codex "Not logged in" as missing', async () => {
    const status = await probeNodeAgentLogin({
      provider: 'openai', env, cwd: '/', resolveBinary: present, run: answers('Not logged in', 1),
    });
    expect(status.verdict).toBe('missing');
  });

  it('never calls an unreadable answer a missing login', async () => {
    const status = await probeNodeAgentLogin({
      provider: 'anthropic', env, cwd: '/', resolveBinary: present, run: answers('error: unknown command auth', 1),
    });
    expect(status.verdict).toBe('unknown');
  });

  it('counts an API key in the environment as usable without running the CLI', async () => {
    let ran = false;
    const status = await probeNodeAgentLogin({
      provider: 'anthropic',
      env: { ...env, ANTHROPIC_API_KEY: 'sk-ant-test' },
      cwd: '/',
      resolveBinary: absent,
      run: async () => { ran = true; return { exitCode: 0, stdout: '', stderr: '' }; },
    });
    expect(status.verdict).toBe('usable');
    expect(status.detail).toContain('ANTHROPIC_API_KEY');
    expect(ran).toBe(false);
  });
});
