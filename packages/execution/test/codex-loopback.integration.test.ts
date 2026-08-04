// Loopback command-network integration without model traffic.
//
// A fixture proxy models Codex's documented host allowlist and supplies the
// standard proxy environment that real sandboxed commands receive. A no-model
// Codex shim receives tm8's ACTUAL rendered spawn/resume command lines, checks
// their raw arguments, then proves both `curl` and tm8's Node/fetch CLI cross
// the seam while a public host is rejected.

import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createServer, request as httpRequest, type Server } from 'node:http';
import { connect as netConnect } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import {
  buildAgentCommand,
  CODEX_LOOPBACK_CONFIG_OVERRIDES,
  CODEX_LOOPBACK_HOSTS,
  withAgentResume,
  type ResolvedLaunchConfig,
} from '../src/spawn/manifest.js';

interface ListeningServer {
  server: Server;
  url: string;
}

function listen(server: Server): Promise<ListeningServer> {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (!address || typeof address === 'string') {
        reject(new Error('fixture did not bind a TCP port'));
        return;
      }
      resolve({ server, url: `http://127.0.0.1:${String(address.port)}` });
    });
  });
}

function close(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}

/** The first shell that actually exists here; the command itself is POSIX sh. */
function loginShell(): string {
  const candidates = [process.env.SHELL, '/bin/bash', '/bin/sh'].filter(
    (candidate): candidate is string => typeof candidate === 'string' && candidate.length > 0,
  );
  const found = candidates.find((candidate) => existsSync(candidate));
  if (!found) throw new Error(`no usable shell found; tried ${candidates.join(', ')}`);
  return found;
}

function execText(binary: string, args: readonly string[], env: NodeJS.ProcessEnv): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(binary, [...args], { env, timeout: 10_000 }, (error, stdout, stderr) => {
      if (error) {
        reject(new Error(`${error.message}\n${stderr}`));
        return;
      }
      resolve(stdout);
    });
  });
}

const cliPath = fileURLToPath(new URL('../../cli/dist/index.js', import.meta.url));
const curlPath = '/usr/bin/curl';
const hasFixtures = existsSync(cliPath) && existsSync(curlPath);
const describeWithFixtures = hasFixtures ? describe : describe.skip;

describeWithFixtures('Codex loopback command-network integration', () => {
  const open: Server[] = [];
  const temporaryDirectories: string[] = [];

  afterEach(async () => {
    await Promise.all(open.splice(0).map(close));
    await Promise.all(
      temporaryDirectories.splice(0).map((directory) =>
        rm(directory, { recursive: true, force: true }),
      ),
    );
  });

  it('allows loopback curl + bounded tm8 reads on spawn/resume and denies public traffic', async () => {
    const tm8Fixture = await listen(
      createServer((req, res) => {
        if (req.url === '/v2/identity') {
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(
            JSON.stringify({
              data: {
                identityId: 'fixture-identity',
                username: 'fixture-owner',
                displayName: 'Fixture Owner',
                status: 'active',
                isOwner: true,
                isNodeAdmin: true,
                memberships: [],
              },
              requestId: 'fixture-request',
            }),
          );
          return;
        }
        res.writeHead(200, { 'content-type': 'text/plain' });
        res.end('tm8-loopback-ok');
      }),
    );
    open.push(tm8Fixture.server);

    const requestedHosts: string[] = [];
    const proxyServer = createServer((req, res) => {
      let target: URL;
      try {
        target = new URL(req.url ?? '');
      } catch {
        res.writeHead(400).end('absolute proxy URL required');
        return;
      }
      requestedHosts.push(target.hostname);
      if (!(CODEX_LOOPBACK_HOSTS as readonly string[]).includes(target.hostname)) {
        res.writeHead(403).end('destination denied by fixture proxy');
        return;
      }
      const upstream = httpRequest(
        {
          hostname: target.hostname,
          port: target.port,
          path: `${target.pathname}${target.search}`,
          method: req.method,
          headers: req.headers,
        },
        (upstreamResponse) => {
          res.writeHead(upstreamResponse.statusCode ?? 502, upstreamResponse.headers);
          upstreamResponse.pipe(res);
        },
      );
      upstream.on('error', (error) => res.writeHead(502).end(error.message));
      req.pipe(upstream);
    });
    proxyServer.on('connect', (req, client, head) => {
      const [hostname = '', rawPort = '80'] = (req.url ?? '').split(':');
      requestedHosts.push(hostname);
      if (!(CODEX_LOOPBACK_HOSTS as readonly string[]).includes(hostname)) {
        client.end('HTTP/1.1 403 Forbidden\r\n\r\n');
        return;
      }
      const upstream = netConnect(Number(rawPort), hostname, () => {
        client.write('HTTP/1.1 200 Connection Established\r\n\r\n');
        if (head.length > 0) upstream.write(head);
        upstream.pipe(client);
        client.pipe(upstream);
      });
      upstream.on('error', () => client.destroy());
    });
    const proxyFixture = await listen(proxyServer);
    open.push(proxyFixture.server);

    const shimDirectory = await mkdtemp(join(tmpdir(), 'tm8-codex-network-shim-'));
    temporaryDirectories.push(shimDirectory);
    const shimPath = join(shimDirectory, 'codex');
    await writeFile(
      shimPath,
      `#!/usr/bin/env node
const { spawnSync } = require('node:child_process');
const argv = process.argv.slice(2);
const required = JSON.parse(process.env.TM8_TEST_REQUIRED_OVERRIDES || '[]');
for (const value of required) {
  const found = argv.some((argument, index) => argument === '-c' && argv[index + 1] === value);
  if (!found) {
    process.stderr.write('missing Codex override: ' + value + '\\n');
    process.exit(64);
  }
}
if (argv.includes('--dangerously-bypass-approvals-and-sandbox')) process.exit(65);
const phase = argv[0] === 'resume' ? 'resume' : 'spawn';
const curl = spawnSync('/usr/bin/curl', [
  '--fail', '--silent', '--show-error', process.env.TM8_TEST_LOOPBACK_URL + '/health',
], { encoding: 'utf8', env: process.env });
if (curl.status !== 0) {
  process.stderr.write(curl.stderr || 'loopback curl failed\\n');
  process.exit(66);
}
const identity = spawnSync(process.execPath, [
  process.env.TM8_TEST_CLI_PATH, 'identity', 'get', '--format', 'json',
], { encoding: 'utf8', env: process.env });
if (identity.status !== 0) {
  process.stderr.write(identity.stderr || 'tm8 identity failed\\n');
  process.exit(67);
}
const publicProbe = spawnSync('/usr/bin/curl', [
  '--fail', '--silent', '--show-error', 'http://example.com/',
], { encoding: 'utf8', env: process.env });
if (publicProbe.status === 0) process.exit(68);
process.stdout.write(JSON.stringify({
  phase,
  loopback: curl.stdout,
  identity: JSON.parse(identity.stdout),
  publicDenied: true,
  nativeId: phase === 'resume' ? argv.at(-1) : null,
}));
`,
      'utf8',
    );
    await chmod(shimPath, 0o755);

    const env: NodeJS.ProcessEnv = {
      ...process.env,
      PATH: `${shimDirectory}:${process.env.PATH ?? ''}`,
      HTTP_PROXY: proxyFixture.url,
      HTTPS_PROXY: proxyFixture.url,
      http_proxy: proxyFixture.url,
      https_proxy: proxyFixture.url,
      NO_PROXY: '',
      no_proxy: '',
      NODE_USE_ENV_PROXY: '1',
      TM8_BASE_URL: tm8Fixture.url,
      TM8_AGENT_TOKEN: 'fixture-token',
      TM8_TEST_CLI_PATH: cliPath,
      TM8_TEST_LOOPBACK_URL: tm8Fixture.url,
      TM8_TEST_REQUIRED_OVERRIDES: JSON.stringify(CODEX_LOOPBACK_CONFIG_OVERRIDES),
    };

    const launch: ResolvedLaunchConfig = {
      mode: 'worker',
      model: 'gpt-5.6-sol',
      agentTool: 'codex',
      permissionMode: 'acceptEdits',
      accessMode: 'acceptEdits',
      reasoningEffort: 'low',
    };
    const spawnCommand = buildAgentCommand(launch, {});
    const invocations = [
      { phase: 'spawn', command: spawnCommand, nativeId: null },
      {
        phase: 'resume',
        command: withAgentResume(
          spawnCommand,
          '<tm8_system_prompt>resume policy</tm8_system_prompt>',
          launch,
          'fixture-native-session-id',
          {},
        ),
        nativeId: 'fixture-native-session-id',
      },
    ];

    for (const invocation of invocations) {
      // The command is POSIX sh, and the shell that runs it is not part of what
      // this test measures. '/bin/zsh' was hardcoded here — a macOS default that
      // does not exist on a Linux node, where this failed with a bare
      // `spawn /bin/zsh ENOENT` long before reaching a single assertion.
      const output = await execText(loginShell(), ['-c', invocation.command], env);
      const result = JSON.parse(output) as {
        phase: string;
        loopback: string;
        identity: { identityId: string; username: string };
        publicDenied: boolean;
        nativeId: string | null;
      };
      expect(result, invocation.phase).toMatchObject({
        phase: invocation.phase,
        loopback: 'tm8-loopback-ok',
        publicDenied: true,
        nativeId: invocation.nativeId,
      });
      expect(result.identity, `${invocation.phase} tm8 identity`).toMatchObject({
        identityId: 'fixture-identity',
        username: 'fixture-owner',
      });
    }
    expect(requestedHosts).toContain('127.0.0.1');
    expect(requestedHosts).toContain('example.com');
  }, 20_000);
});
