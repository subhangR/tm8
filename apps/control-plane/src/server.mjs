import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { MachineRegistrationSchema } from '@tm8/contract';
import { DirectoryError } from './directory.mjs';
import { origin } from './auth.mjs';

const uuid = /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i;
const validId = id => { if (!uuid.test(id ?? '')) throw new DirectoryError('invalid_id', 400); return id; };
const textInput = (input, key, max = 2048) => {
  const value = input?.[key];
  if (typeof value !== 'string' || !value.length || value.length > max) throw new DirectoryError(`invalid_${key}`, 400);
  return value;
};
function cookie(req, name) {
  const matches = (req.headers.cookie ?? '').split(';').map(part => part.trim()).filter(part => part.startsWith(`${name}=`));
  if (matches.length > 1) throw new DirectoryError('conflicting_credentials', 401);
  return matches[0]?.slice(name.length + 1);
}
async function body(req) {
  const parts = []; let length = 0;
  for await (const chunk of req) {
    length += chunk.length;
    if (length > 32768) throw new DirectoryError('request_too_large', 413);
    parts.push(chunk);
  }
  try { return JSON.parse(Buffer.concat(parts).toString('utf8') || '{}'); }
  catch { throw new DirectoryError('invalid_json', 400); }
}

export function createControlServer({ directory, auth, publicOrigin }) {
  const secure = publicOrigin.startsWith('https:');
  const sessionName = secure ? '__Host-tm8_control' : 'tm8_control';
  const flowName = secure ? '__Host-tm8_flow' : 'tm8_flow';
  const setCookie = (name, value, seconds) => `${name}=${value}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${seconds}${secure ? '; Secure' : ''}`;
  const rates = new Map();
  const server = createServer(async (req, res) => {
    res.setHeader('cache-control', 'no-store');
    res.setHeader('referrer-policy', 'no-referrer');
    res.setHeader('x-content-type-options', 'nosniff');
    res.setHeader('content-security-policy', "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'");
    const json = (data, status = 200) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify({ data })); };
    try {
      const url = new URL(req.url ?? '/', publicOrigin);
      const bearer = /^Bearer ([A-Za-z0-9_-]+)$/.exec(req.headers.authorization ?? '')?.[1];
      const browserToken = cookie(req, sessionName);
      if (bearer && browserToken && bearer !== browserToken) throw new DirectoryError('conflicting_credentials', 401);
      const token = bearer ?? browserToken;
      if (req.method !== 'GET' && req.method !== 'HEAD') {
        // A CLI or enrolled node uses a bearer. Browsers must prove same origin,
        // including on login/logout to prevent login CSRF.
        if ((browserToken || !bearer) && req.headers.origin !== publicOrigin) throw new DirectoryError('invalid_origin', 403);
        if (req.headers.origin && req.headers.origin !== publicOrigin) throw new DirectoryError('invalid_origin', 403);
        if (!req.headers['content-type']?.startsWith('application/json')) throw new DirectoryError('json_required', 415);
      }
      if (url.pathname.startsWith('/auth/') || url.pathname.startsWith('/api/')) {
        const now = Date.now();
        for (const [key, value] of rates) if (value.until <= now) rates.delete(key);
        const key = req.socket.remoteAddress;
        const bucket = rates.get(key) ?? { count: 0, until: now + 60000 };
        if (++bucket.count > 120 || (!rates.has(key) && rates.size >= 10000)) throw new DirectoryError('rate_limited', 429);
        rates.set(key, bucket);
      }
      if (req.method === 'GET' && url.pathname === '/health') {
        await directory.pool.query('select 1'); return json({ status: 'ok' });
      }
      if (req.method === 'GET' && url.pathname === '/api/capabilities') return json({
        distributedSystemFlag: true, role: 'control', authentication: 'supabase', signInProviders: ['github'], registration: 'invite-only',
        automaticMachineProvisioning: false, crossMachineSharing: false,
      });
      if (req.method === 'GET' && url.pathname === '/api/me') {
        const account = await directory.session(token);
        return json({ accountId: account.id, email: account.email, isAdmin: account.is_admin });
      }
      if (req.method === 'GET' && url.pathname === '/auth/callback') {
        const flow = await auth.finishGithub(cookie(req, flowName), url.searchParams.get('code'));
        const session = await directory.login(flow.user, flow.invitationCode, flow.parentSessionId);
        res.setHeader('set-cookie', [setCookie(sessionName, session.token, 43200), setCookie(flowName, '', 0)]);
        res.writeHead(303, { location: '/' }); return res.end();
      }
      if (req.method === 'GET' && url.pathname === '/api/machines') return json(await directory.listMachines(token));
      if (req.method === 'POST') {
        const input = await body(req);
        switch (url.pathname) {
          case '/auth/signup': case '/auth/login': case '/auth/reset': case '/auth/password': case '/auth/exchange':
            throw new DirectoryError('github_authentication_required', 403);
          case '/auth/github': {
            if (input.intent && !['login', 'link'].includes(input.intent)) throw new DirectoryError('invalid_intent', 400);
            const parent = input.intent === 'link' ? (await directory.session(token)).session_id : null;
            const flow = await auth.startGithub(input.invitationCode, parent);
            res.setHeader('set-cookie', setCookie(flowName, flow.state, 600));
            return json({ redirectUrl: flow.url });
          }
          case '/auth/logout':
            await directory.logout(token); res.setHeader('set-cookie', setCookie(sessionName, '', 0)); return json({ ok: true });
          case '/api/assignment': return json(await directory.allocate(token));
          case '/api/handoff': return json(await directory.issueHandoff(token));
          case '/api/machines': {
            const result = MachineRegistrationSchema.safeParse(input);
            if (!result.success) throw new DirectoryError('invalid_machine', 400);
            try { result.data.publicOrigin = origin(result.data.publicOrigin, !secure); } catch { throw new DirectoryError('invalid_public_origin', 400); }
            return json(await directory.registerMachine(token, result.data), 201);
          }
          case '/api/machines/configure':
            if (typeof input.draining !== 'boolean') throw new DirectoryError('invalid_draining', 400);
            await directory.configureMachine(token, validId(input.machineId), input.capacity, input.draining); return json({ ok: true });
          case '/api/invitations': {
            const email = textInput(input, 'email', 320);
            if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new DirectoryError('invalid_email', 400);
            return json(await directory.invite(token, email, input.machineId ? validId(input.machineId) : null, input.spaceId ? validId(input.spaceId) : null), 201);
          }
          case '/api/accounts/suspend': await directory.suspend(token, validId(input.accountId)); return json({ ok: true });
          case '/api/invitations/revoke': return json(await directory.revokeInvitation(token, validId(input.invitationId)));
          case '/node/heartbeat': return json(await directory.heartbeat(validId(input.machineId), bearer));
          case '/node/redeem': return json(await directory.redeemHandoff(validId(input.machineId), bearer, textInput(input, 'code')));
          case '/node/lease': return json(await directory.lease(validId(input.machineId), bearer, validId(input.sessionId)));
          case '/node/logout': return json(await directory.nodeLogout(validId(input.machineId), bearer, validId(input.sessionId)));
          case '/node/invitations': {
            if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(textInput(input, 'email', 320)) || !Number.isFinite(Date.parse(input.expiresAt))) throw new DirectoryError('invalid_invitation', 400);
            return json(await directory.nodeInvite(validId(input.machineId), bearer, {
              sessionId: validId(input.sessionId), invitationId: validId(input.invitationId), spaceId: validId(input.spaceId),
              email: input.email, expiresAt: input.expiresAt, code: textInput(input, 'code', 128),
            }));
          }
          case '/node/invitations/revoke': return json(await directory.nodeRevokeInvitation(validId(input.machineId), bearer, validId(input.invitationId)));
          case '/node/workspace-status': await directory.assignmentStatus(validId(input.machineId), bearer, validId(input.workspaceId), input.state); return json({ ok: true });
        }
      }
      if (req.method === 'GET' && ['/', '/app.js', '/app.css'].includes(url.pathname)) {
        const name = url.pathname === '/' ? 'index.html' : url.pathname.slice(1);
        const mime = name.endsWith('.html') ? 'text/html' : name.endsWith('.js') ? 'text/javascript' : 'text/css';
        res.writeHead(200, { 'content-type': `${mime}; charset=utf-8` });
        return res.end(await readFile(new URL(`../public/${name}`, import.meta.url)));
      }
      throw new DirectoryError('not_found', 404);
    } catch (error) {
      const status = error instanceof DirectoryError ? error.status : 500;
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: { code: status === 500 ? 'internal_error' : error.code } }));
      if (status === 500) process.stderr.write(`[control] request failed (${error.code ?? error.name})\n`);
    }
  });
  server.requestTimeout = 15000;
  server.headersTimeout = 10000;
  return server;
}
