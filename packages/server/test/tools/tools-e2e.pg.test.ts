/** Production facade + throwaway Postgres + real PTY + subprocess CLI, local external API stubs. */
import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import { execFile } from 'node:child_process';
import { createServer, type Server } from 'node:http';
import { chmod, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import type { ToolRun, ToolView } from '@tm8/contract';
import { formatToken, generateSecret, hashToken } from '../../src/identity/crypto.js';
import { startWsE2eNode, ownerOfSpace, type WsE2eNode } from '../events/ws-e2e-harness.js';
import { REPO_ROOT } from '../db/w1-pg.js';
vi.setConfig({ testTimeout: 60000, hookTimeout: 300000 });
let node: WsE2eNode, stub: Server, stubUrl: string, spaceId: string, fixtureBin: string;
let persona: string, parent: string, parentAuth: string, agentToken: string;
let revocationPersona: string, revocationParent: string;
let revocationParentAuth: string, revocationAgentToken: string;
const tools = new Map<string, ToolView>(), shells = new Set<string>();
const githubCalls: Array<{ token: string; args: string[] }> = [], slackCalls: Array<{ text: string; channel?: string }> = [];
const apiCalls: Array<{ path: string; authorization?: string }> = [];
const secretValue = 'synthetic-tool-secret-e2e-9fd71', cmid = () => randomUUID();
async function request<T>(method: string, path: string, body?: unknown, token?: string) {
  const response = await fetch(node.baseUrl + path, { method, headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  return { status: response.status, ...await response.json() as { data?: T; error?: { message: string; code: string } } };
}
async function cli(args: string[], agent = false, extra: Record<string, string> = {}) {
  return new Promise<{ code: number; stdout: string; stderr: string }>((resolve, reject) => {
    execFile(process.execPath, [join(REPO_ROOT, 'packages/cli/dist/index.js'), ...args], { cwd: REPO_ROOT, timeout: 30000, maxBuffer: 2 * 1024 * 1024,
      // The harness runs inside a production tm8 session. Never inherit its
      // actor, token, server, or manifest into this isolated scratch database.
      env: { PATH: process.env['PATH'] ?? '/usr/bin:/bin', HOME: process.env['HOME'] ?? '/tmp',
        TM8_BASE_URL: node.baseUrl, TM8_SPACE_ID: spaceId, TM8_CREDENTIALS_MODE: 'off',
        TM8_SESSION_ID: agent ? parent : '', TM8_AGENT_TOKEN: agent ? agentToken : '',
        TM8_MANIFEST_PATH: '', TM8_TEAM_MEMBER_ID: '', TM8_JOURNAL_CLASS: 'human', TM8_NO_TERSE_DEFAULT: '1', ...extra },
    }, (error, stdout, stderr) => {
      if (error && (typeof error.code !== 'number' || error.killed)) return reject(error);
      resolve({ code: typeof error?.code === 'number' ? error.code : 0, stdout, stderr });
    });
  });
}
async function create(name: string, runtime: string, source: string, spec: string) {
  const result = await cli(['--format', 'json', 'tool', 'create', name, '--runtime', runtime, '--source', '@' + source, '--spec', '@' + spec, '--when-to-use', `Open when testing ${name}`, '--summary', 'Local e2e fixture']);
  expect(result.code, result.stderr).toBe(0);
  const view = JSON.parse(result.stdout) as ToolView; tools.set(name, view); return view;
}
async function probe(name: string, source: string, access = 'none', inputs: unknown[] = []) {
  const path = join(node.dataDir, name); await writeFile(path + '.sh', source);
  await writeFile(path + '.json', JSON.stringify({ tm8Access: access, inputs, timeoutSeconds: 20 }));
  return create(name, 'bash', path + '.sh', path + '.json');
}
async function settled(id: string): Promise<ToolRun> {
  let run: ToolRun | undefined;
  await vi.waitFor(async () => { const result = await request<ToolRun>('GET', '/v2/tool-runs/' + id); expect(result.status).toBe(200); run = result.data; expect(run!.state).not.toBe('running'); }, { timeout: 15000, interval: 50 }); return run!;
}
async function closeShell(id: string) {
  node.production.execution!.pty.write(id, 'exit\r');
  await vi.waitFor(() => expect(node.production.execution!.pty.hasSession(id)).toBe(false), { timeout: 5000 });
  const terminated = await request('POST', `/v2/entities/${id}/commands/terminate`, { clientMutationId: cmid() });
  expect(terminated.status, JSON.stringify(terminated.error)).toBe(200);
  shells.delete(id);
}
function sessionOf(stdout: string) { const id = stdout.match(/^[0-9a-f-]{36}$/m)?.[0]; expect(id, stdout).toBeTruthy(); return id!; }
async function launch(tool: ToolView, inputs: Record<string, unknown>, agent = false, secrets?: Record<string, string>) {
  const result = await request<{ sessionId: string }>('POST', `/v2/tools/${tool.id}/run`, { expectedVersion: tool.version, clientMutationId: cmid(), inputs, secrets, keepOpen: true }, agent ? agentToken : undefined);
  expect(result.status, JSON.stringify(result.error)).toBe(200); shells.add(result.data!.sessionId); return settled(result.data!.sessionId);
}
beforeAll(async () => {
  // Stable reverse-proxy origin before bootstrap binds port 0; /v2 remains the real server.
  stub = createServer(async (req, res) => {
    try {
      const chunks: Buffer[] = []; for await (const chunk of req) chunks.push(Buffer.from(chunk)); const body = Buffer.concat(chunks);
      if (req.url === '/ok') { res.end('ok'); return; }
      if (req.url === '/fail') { res.writeHead(503); res.end('unavailable'); return; }
      if (req.url === '/github') { githubCalls.push(JSON.parse(body.toString())); res.setHeader('content-type', 'application/json'); res.end(JSON.stringify([{ number: 7, title: 'Stub PR', state: 'OPEN', statusCheckRollup: [] }])); return; }
      if (req.url === '/slack') { slackCalls.push(JSON.parse(body.toString())); res.end('ok'); return; }
      apiCalls.push({ path: req.url!, authorization: req.headers.authorization });
      const upstream = await fetch(node.baseUrl + req.url, { method: req.method!, headers: { 'content-type': 'application/json', ...(req.headers.authorization ? { authorization: req.headers.authorization } : {}) }, ...(body.length ? { body } : {}) });
      res.writeHead(upstream.status, { 'content-type': 'application/json' }); res.end(await upstream.text());
    } catch { res.writeHead(500); res.end('stub proxy failed'); }
  });
  await new Promise<void>(resolve => stub.listen(0, '127.0.0.1', resolve));
  const address = stub.address(); if (!address || typeof address === 'string') throw new Error('No stub port'); stubUrl = `http://127.0.0.1:${address.port}`;
  fixtureBin = join(REPO_ROOT, '.tools-e2e-bin-' + cmid()); await mkdir(fixtureBin);
  await writeFile(join(fixtureBin, 'gh'), `#!/usr/bin/python3\nimport json, os, sys, urllib.request\nreq = urllib.request.Request(${JSON.stringify(stubUrl + '/github')}, data=json.dumps({'token': os.environ['GH_TOKEN'], 'args': sys.argv[1:]}).encode(), headers={'Content-Type': 'application/json'})\nwith urllib.request.urlopen(req) as r: print(r.read().decode())\n`); await chmod(join(fixtureBin, 'gh'), 0o700);
  vi.stubEnv('PATH', fixtureBin + ':' + process.env['PATH']); vi.stubEnv('TM8_PUBLIC_ORIGIN', stubUrl);
  node = await startWsE2eNode('tools');
  const created = await node.request<{ space: { id: string } }>('POST', '/v2/spaces', { name: 'Tools e2e', clientMutationId: cmid() }); expect(created.status, JSON.stringify(created.error)).toBe(201); spaceId = created.data!.space.id;
  const owner = await ownerOfSpace(node.database, spaceId); persona = cmid(); parent = cmid(); parentAuth = cmid();
  revocationPersona = cmid(); revocationParent = cmid(); revocationParentAuth = cmid();
  const secret = generateSecret(); agentToken = formatToken(parentAuth, secret);
  const revocationSecret = generateSecret(); revocationAgentToken = formatToken(revocationParentAuth, revocationSecret);
  // Seed only the test invoker; its bearer is resolved by production auth and RLS.
  await node.database.transaction(async q => {
    await q.query('set local role tm8_graph_owner');
    await q.query("select set_config('tm8.identity_id',$1,true),set_config('tm8.auth_kind','browser',true)", [owner.identityId]);
    await q.query("insert into public.entities(id,space_id,kind,position,created_by) values($1,$3,'team_member',0,$4),($2,$3,'work_session',0,$1)", [persona, parent, spaceId, owner.memberId]);
    await q.query("insert into public.team_members(entity_id,owner_member_id,name,role,identity) values($1,$2,'Tools e2e agent','','persona')", [persona, owner.memberId]);
    await q.query("insert into public.work_sessions(entity_id,title,status,share_mode,workdir_path) values($1,'Tools e2e parent','running','none',$2)", [parent, node.dataDir]);
    await q.query("insert into public.edges(space_id,src_id,dst_id,type,created_by) values($1,$2,$3,'participates_in',$2)", [spaceId, persona, parent]);
    await q.query("insert into public.entities(id,space_id,kind,position,created_by) values($1,$3,'team_member',0,$4),($2,$3,'work_session',0,$1)", [revocationPersona, revocationParent, spaceId, owner.memberId]);
    await q.query("insert into public.team_members(entity_id,owner_member_id,name,role,identity) values($1,$2,'Revocation-test agent','','persona')", [revocationPersona, owner.memberId]);
    await q.query("insert into public.work_sessions(entity_id,title,status,share_mode,workdir_path) values($1,'Revocation-test parent','running','none',$2)", [revocationParent, node.dataDir]);
    await q.query("insert into public.edges(space_id,src_id,dst_id,type,created_by) values($1,$2,$3,'participates_in',$2)", [spaceId, revocationPersona, revocationParent]);
    await q.query("insert into public.auth_sessions(id,account_id,kind,acting_as_team_member_id,work_session_id,space_id,token_hash,expires_at) select $1,id,'agent',$2,$3,$4,$5,now()+interval '2 hours' from public.accounts where identity_id=$6", [parentAuth, persona, parent, spaceId, hashToken(secret), owner.identityId]);
    await q.query("insert into public.auth_sessions(id,account_id,kind,acting_as_team_member_id,work_session_id,space_id,token_hash,expires_at) select $1,id,'agent',$2,$3,$4,$5,now()+interval '2 hours' from public.accounts where identity_id=$6", [revocationParentAuth, revocationPersona, revocationParent, spaceId, hashToken(revocationSecret), owner.identityId]);
  });
});
afterAll(async () => {
  for (const id of shells) node?.production.execution?.pty.kill(id);
  for (const id of shells) await settled(id);
  await node?.close();
  if (stub) await new Promise<void>(resolve => stub.close(() => resolve()));
  if (fixtureBin) await rm(fixtureBin, { recursive: true, force: true }); vi.unstubAllEnvs();
});
it('creates all four starters through the CLI and runs them from agent sessions', async () => {
  for (const name of ['url-check', 'gh-pr-status', 'space-digest', 'slack-notify']) { const dir = join(REPO_ROOT, 'examples/tools', name); await create(name, name === 'space-digest' ? 'python' : 'bash', join(dir, name === 'space-digest' ? 'tool.py' : 'tool.sh'), join(dir, 'spec.json')); }
  const url = await cli(['tool', 'run', '--detach', 'url-check', '--urls', stubUrl + '/ok'], true); expect(url.code, url.stderr + url.stdout).toBe(0); expect((await settled(sessionOf(url.stdout))).outputTail).toContain('OK 200');
  const gh = await cli(['tool', 'run', '--detach', 'gh-pr-status', '--repo', 'owner/repo', '--state', 'closed', '--limit', '3', '--github-token-from-env', 'FIXTURE_TOKEN'], true, { FIXTURE_TOKEN: secretValue }); expect(gh.code, gh.stderr + gh.stdout).toBe(0); expect((await settled(sessionOf(gh.stdout))).outputTail).toContain('Stub PR');
  expect(githubCalls.at(-1)).toEqual({ token: secretValue, args: ['pr', 'list', '--repo', 'owner/repo', '--state', 'closed', '--limit', '3', '--json', 'number,title,url,state,isDraft,statusCheckRollup'] });
  const text = 'Digest "quoted"\nUnicode: 🛠'; const slack = await cli(['tool', 'run', '--detach', 'slack-notify', '--text', text, '--channel', '#build', '--slack-webhook-url-from-env', 'FIXTURE_WEBHOOK'], true, { FIXTURE_WEBHOOK: stubUrl + '/slack' }); expect(slack.code, slack.stderr + slack.stdout).toBe(0); await settled(sessionOf(slack.stdout)); expect(slackCalls.at(-1)).toEqual({ text, channel: '#build' });
  const digest = await cli(['tool', 'run', '--detach', 'space-digest', '--since', '0', '--format', 'markdown'], true); expect(digest.code, digest.stderr + digest.stdout).toBe(0);
  const id = sessionOf(digest.stdout), run = await settled(id); expect(run.outputTail).toContain('# Space digest'); expect(run.parentSessionId).toBe(parent);
  expect(apiCalls.some(call => call.path.includes('/events?'))).toBe(true);
  for (const call of apiCalls) { expect(call.authorization).toMatch(/^Bearer tm8s_/); expect(call.authorization).not.toBe(`Bearer ${agentToken}`); }
  const [row] = await node.database.query<{ api_scope: string; revoked_at: unknown }>('select api_scope,revoked_at from public.auth_sessions where work_session_id=$1', [id]); expect(row!.api_scope).toBe('read'); expect(row!.revoked_at).toBeTruthy();
});
it('runs the three no-access starters via the human UI API, retaining shells; refuses human digest', async () => {
  const gh = tools.get('gh-pr-status')!;
  const bound = await request('POST', `/v2/tools/${gh.id}/secrets/bind`, { expectedVersion: gh.version, clientMutationId: cmid(), inputName: 'github_token', value: secretValue }); expect(bound.status, JSON.stringify(bound.error)).toBe(200);
  const refreshed = await request<ToolView>('GET', '/v2/tools/' + gh.id); tools.set('gh-pr-status', refreshed.data!);
  const runs = [await launch(tools.get('url-check')!, { urls: stubUrl + '/ok' }), await launch(refreshed.data!, { repo: 'owner/repo' }), await launch(tools.get('slack-notify')!, { text: 'Human run' }, false, { slack_webhook_url: stubUrl + '/slack' })];
  for (const run of runs) { expect(run.exitCode).toBe(0); expect(run.keepOpen).toBe(true); expect(node.production.execution!.pty.hasSession(run.id)).toBe(true); }
  await Promise.all(runs.map(run => closeShell(run.id)));
  const refused = await request('POST', `/v2/tools/${tools.get('space-digest')!.id}/run`, { clientMutationId: cmid(), inputs: {}, keepOpen: true }); expect(refused.status).toBe(403); expect(refused.error!.message).toContain('invoking agent');
});
it('updates, configures and unbinds secrets with route-only ids through the CLI', async () => {
  const gh = tools.get('gh-pr-status')!;
  const spec = join(REPO_ROOT, 'examples/tools/gh-pr-status/spec.json');
  const edited = await cli(['--format', 'json', 'tool', 'edit', gh.id, '--spec', '@' + spec,
    '--description', 'Edited starter', '--expect-version', String(gh.version)]);
  expect(edited.code, edited.stderr).toBe(0);
  const configured = await cli(['--format', 'json', 'tool', 'config', 'set', gh.id, 'repo', 'owner/repo']);
  expect(configured.code, configured.stderr).toBe(0);
  expect(JSON.parse(configured.stdout).config.repo).toBe('owner/repo');
  const unset = await cli(['--format', 'json', 'tool', 'config', 'unset', gh.id, 'repo']);
  expect(unset.code, unset.stderr).toBe(0);
  expect(JSON.parse(unset.stdout).config).not.toHaveProperty('repo');
  const unbound = await cli(['--format', 'json', 'tool', 'secret', 'unset', gh.id, 'github_token']);
  expect(unbound.code, unbound.stderr).toBe(0);
  expect(JSON.parse(unbound.stdout).secretBindings).toEqual([]);
});
it('propagates 0 and nonzero exit codes through attached CLI execution', async () => {
  for (const [path, code] of [['/ok', 0], ['/fail', 1]] as const) { const result = await cli(['tool', 'run', 'url-check', '--urls', stubUrl + path], true); const run = await settled(sessionOf(result.stdout)); expect(run.exitCode, `${path}: ${run.outputTail}`).toBe(code); expect(result.code, `${path}: CLI ${result.code}, run ${run.exitCode}; ${run.outputTail}`).toBe(code); expect(node.production.execution!.pty.hasSession(run.id)).toBe(false); }
});
it('redacts tail/events/ledger and leaves a usable shell without secrets or agent env', async () => {
  const tool = await probe('secret-probe', 'printf "%s|%s|%s\\n" "$KEY" "$OTHER_SECRET" "$TM8_AGENT_TOKEN"', 'read', [{ name: 'key', type: 'secret', required: true }, { name: 'other', type: 'secret', env: 'OTHER_SECRET', required: true }]); const run = await launch(tool, {}, true, { key: secretValue, other: 'second-synthetic-secret' }); expect(run.exitCode).toBe(0); expect(run.outputTail).toContain('[credential-redacted]|[credential-redacted]|[credential-redacted]');
  const persisted = JSON.stringify(await node.database.query('select to_jsonb(w) from public.work_sessions w where entity_id=$1', [run.id]));
  const events = JSON.stringify(await node.database.query('select to_jsonb(e) from public.workspace_events e where space_id=$1', [spaceId])); const ledger = JSON.stringify(await node.database.query('select to_jsonb(l) from public.command_ledger l'));
  for (const surface of [JSON.stringify(run), persisted, events, ledger]) { expect(surface).not.toContain(secretValue); expect(surface).not.toContain('second-synthetic-secret'); expect(surface).not.toMatch(/tm8s_/); }
  const pty = node.production.execution!.pty; pty.write(run.id, "printf 'shell-usable\\n'; python3 -I -c 'import os; print(\"ENV-PROBE:\" + repr({k: os.environ[k] for k in [\"KEY\", \"OTHER_SECRET\", \"TM8_AGENT_TOKEN\", \"TM8_SESSION_ID\"] if k in os.environ}))'\r");
  await vi.waitFor(() => { const replay = pty.getReplay(run.id, -1)!.data.toString(); expect(replay).toContain('ENV-PROBE:{}'); expect(replay).toContain('shell-usable'); }, { timeout: 5000 });
  await closeShell(run.id);
});
it('kills background children when a closed run settles', async () => {
  const tool = await probe('children-probe', 'sleep 600 &\nprintf "child-pid:%s\\n" "$!"\nexit 0'); const result = await cli(['tool', 'run', tool.id], true); expect(result.code, result.stderr).toBe(0); const run = await settled(sessionOf(result.stdout)); const pid = Number(run.outputTail.match(/child-pid:(\d+)/)?.[1]); expect(pid).toBeGreaterThan(0);
  await vi.waitFor(async () => { let running = false; try { const stat = await readFile(`/proc/${pid}/stat`, 'utf8'); running = stat.slice(stat.lastIndexOf(')') + 2).split(' ')[0] !== 'Z'; } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; } expect(running).toBe(false); }, { timeout: 5000 });
});
it('permits reads with a live run token and refuses writes with 403', async () => {
  const source = `python3 -I - <<'PY'\nimport json, os, urllib.request, urllib.error\nbase = os.environ['TM8_BASE_URL']; headers = {'Authorization': 'Bearer ' + os.environ['TM8_AGENT_TOKEN'], 'Content-Type': 'application/json'}\nwith urllib.request.urlopen(urllib.request.Request(base + '/v2/entities/' + os.environ['TM8_SESSION_ID'], headers=headers)) as r: print('read-status:' + str(r.status))\nreq = urllib.request.Request(base + '/v2/entities', data=json.dumps({'spaceId': '${spaceId}', 'kind': 'task', 'title': 'Forbidden write', 'clientMutationId': '${cmid()}'}).encode(), headers=headers)\ntry:\n    urllib.request.urlopen(req)\n    raise RuntimeError('write unexpectedly allowed')\nexcept urllib.error.HTTPError as e:\n    print('write-status:' + str(e.code))\n    assert e.code == 403\nPY`;
  const tool = await probe('scope-probe', source, 'read'), result = await cli(['tool', 'run', '--detach', tool.id], true); expect(result.code, result.stderr + result.stdout).toBe(0); const run = await settled(sessionOf(result.stdout)); expect(run.exitCode).toBe(0); expect(run.outputTail).toContain('read-status:200'); expect(run.outputTail).toContain('write-status:403');
});
it('cascades parent revocation to a still-running tool token', async () => {
  const tool = await probe('revoke-probe', `python3 -I - <<'PY'\nimport os, urllib.request\nreq = urllib.request.Request(os.environ['TM8_BASE_URL'] + '/v2/entities/' + os.environ['TM8_SESSION_ID'], headers={'Authorization': 'Bearer ' + os.environ['TM8_AGENT_TOKEN']})\nwith urllib.request.urlopen(req) as r: print('ready:' + str(r.status))\nPY\nsleep 20`, 'read'); const started = await request<{ sessionId: string }>('POST', `/v2/tools/${tool.id}/run`, { clientMutationId: cmid(), inputs: {}, keepOpen: false }, revocationAgentToken); expect(started.status, JSON.stringify(started.error)).toBe(200); const id = started.data!.sessionId; shells.add(id);
  await vi.waitFor(() => expect(apiCalls.some(call => call.path === '/v2/entities/' + id)).toBe(true), { timeout: 5000 });
  const runToken = apiCalls.find(call => call.path === '/v2/entities/' + id)!.authorization!.slice(7);
  expect((await request('GET', '/v2/entities/' + id, undefined, runToken)).status).toBe(200);
  const [bearer] = await node.database.query<{ id: string; revoked_at: unknown }>('select id,revoked_at from public.auth_sessions where work_session_id=$1', [id]); expect(bearer!.revoked_at).toBeNull(); await node.database.query('update public.auth_sessions set revoked_at=now() where id=$1', [revocationParentAuth]);
  const [revoked] = await node.database.query<{ revoked_at: unknown }>('select revoked_at from public.auth_sessions where id=$1', [bearer!.id]); expect(revoked!.revoked_at).toBeTruthy();
  expect((await request('GET', '/v2/entities/' + id, undefined, runToken)).status).toBe(401);
});
