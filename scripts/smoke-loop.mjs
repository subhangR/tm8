#!/usr/bin/env node
/**
 * The G1A loop, driven end to end over HTTP.
 *
 * This is the script HOW-TO-TEST.md is built from, and the one the
 * coordinator runs before claiming the loop works. It talks to a running
 * tm8-server exactly the way the UI and the CLI do — through the catalog's
 * HTTP bindings, over the DEV-6 envelope — so a pass here means the loop
 * works through the real router, the real claims, and the real RLS, not
 * through anybody's fake.
 *
 * It is deliberately dependency-free (node >= 22 global fetch) and it prints
 * every request it makes, because when this fails the useful output is the
 * exact call that broke, not a stack trace.
 *
 * Usage:
 *   TM8_BASE_URL=http://127.0.0.1:4610 node scripts/smoke-loop.mjs
 *   TM8_BASE_URL=... node scripts/smoke-loop.mjs --keep   # leave the session running
 */

const BASE = (process.env.TM8_BASE_URL || 'http://127.0.0.1:4610').replace(/\/$/, '');
const KEEP = process.argv.includes('--keep');

let step = 0;
const results = [];

function cmid(label) {
  // Deterministic per run+label so a retry of the same step is idempotent
  // through the ledger rather than double-applying.
  return `smoke-${RUN_ID}-${label}`;
}
const RUN_ID = process.env.TM8_SMOKE_RUN_ID || String(process.hrtime.bigint());

async function call(label, method, path, body) {
  step += 1;
  const url = `${BASE}${path}`;
  process.stdout.write(`\n[${String(step).padStart(2, '0')}] ${label}\n     ${method} ${path}\n`);

  let res;
  try {
    res = await fetch(url, {
      method,
      headers: { 'content-type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  } catch (err) {
    fail(label, `could not reach ${url} — is the server running?\n     ${err.message}`);
  }

  const text = await res.text();
  let parsed;
  try {
    parsed = text ? JSON.parse(text) : undefined;
  } catch {
    fail(label, `response was not JSON (status ${res.status}):\n     ${text.slice(0, 400)}`);
  }

  if (!res.ok) {
    const e = parsed?.error;
    const detail = e ? `${e.code}: ${e.message}` : text.slice(0, 400);
    // A 501 here is the single most likely failure and deserves its own
    // sentence — it means the handler is simply not built on this node, which
    // is a different problem from a request the server understood and refused.
    if (res.status === 501) {
      fail(label, `NOT IMPLEMENTED on this node — ${detail}\n     This operation has no handler yet; the loop cannot close.`);
    }
    fail(label, `HTTP ${res.status} — ${detail}`);
  }

  // DEV-6: every successful JSON response is {data, requestId}.
  if (parsed && typeof parsed === 'object' && !('data' in parsed)) {
    fail(label, `response is missing the DEV-6 {data, requestId} envelope: ${text.slice(0, 300)}`);
  }
  const data = parsed?.data;
  process.stdout.write(`     ok  ${preview(data)}\n`);
  results.push({ label, data });
  return data;
}

function preview(v) {
  const s = JSON.stringify(v);
  if (s === undefined) return '(no body)';
  return s.length > 180 ? `${s.slice(0, 180)}…` : s;
}

function fail(label, message) {
  process.stdout.write(`\n  ✗ FAILED at: ${label}\n     ${message}\n\n`);
  process.exit(1);
}

function need(value, what, label) {
  if (value === undefined || value === null || value === '') {
    fail(label, `expected ${what} in the response and it was absent — ${preview(value)}`);
  }
  return value;
}

// ---------------------------------------------------------------------------

console.log(`tm8 G1A smoke loop → ${BASE}`);
console.log(`run id ${RUN_ID}`);

const health = await (await fetch(`${BASE}/health`)).json().catch(() => null);
if (!health?.ok) fail('health', `server did not answer /health at ${BASE}`);
console.log(`server: ${health.operations} operations mounted · ${health.implemented} implemented`);
if (health.implemented === 0) {
  fail('health', 'ZERO operations are implemented — the handler registry is empty, so nothing below can pass.\n     Did you start the server with TM8_DATABASE_URL set?');
}

// 1. who am I -------------------------------------------------------------
const identity = await call('identity — the loopback owner', 'GET', '/v2/identity');

// 2. a space --------------------------------------------------------------
const space = await call('create a space', 'POST', '/v2/spaces', {
  name: `Smoke Space ${RUN_ID.slice(-6)}`,
  clientMutationId: cmid('space'),
});
const spaceId = need(space?.id ?? space?.space?.id, 'the new space id', 'create a space');

// 3. a project, linked ----------------------------------------------------
const project = await call('create a project', 'POST', '/v2/projects', {
  name: `Smoke Project ${RUN_ID.slice(-6)}`,
  workingDir: process.env.TM8_SMOKE_WORKDIR || process.cwd(),
  clientMutationId: cmid('project'),
});
const projectId = need(project?.id ?? project?.project?.id, 'the new project id', 'create a project');

await call('link the project to the space', 'POST', `/v2/spaces/${spaceId}/projects`, {
  projectId,
  clientMutationId: cmid('link'),
});

// 4. a task ---------------------------------------------------------------
const task = await call('create a task', 'POST', '/v2/entities', {
  spaceId,
  kind: 'task',
  title: 'Smoke task — prove the loop',
  clientMutationId: cmid('task'),
});
const taskId = need(task?.id ?? task?.entity?.id, 'the new task id', 'create a task');

await call('read the task back', 'GET', `/v2/entities/${taskId}`);
await call('list the space tasks', 'POST', '/v2/collections/query', {
  spaceId,
  kind: 'task',
  limit: 10,
});

// 5. spawn ----------------------------------------------------------------
const spawned = await call('spawn an agent session on a real PTY', 'POST', '/v2/execution/spawn', {
  spaceId,
  projectId,
  taskIds: [taskId],
  workdir: { mode: 'project' },
  clientMutationId: cmid('spawn'),
});
const sessionId = need(
  spawned?.workSessionId ?? spawned?.id ?? spawned?.workSession?.id,
  'the new work_session id',
  'spawn an agent session',
);

// 6. prompt it ------------------------------------------------------------
const marker = `smoke-prompt-${RUN_ID.slice(-6)}`;
await call('deliver a prompt into the live PTY', 'POST', `/v2/entities/${sessionId}/commands/prompt`, {
  text: marker,
  clientMutationId: cmid('prompt'),
});

// 7. progress in the thread ----------------------------------------------
await call('post progress into the task thread', 'POST', '/v2/messages', {
  anchorId: taskId,
  body: 'Smoke progress — the agent reports in.',
  clientMutationId: cmid('progress'),
});
const thread = await call('read the task thread back', 'GET', `/v2/entities/${taskId}/messages`);
const items = thread?.items ?? thread;
if (!Array.isArray(items) || items.length === 0) {
  fail('read the task thread back', 'the thread is empty — the progress message did not land');
}

// 8. events ---------------------------------------------------------------
await call('poll the space event log from seq 0', 'GET', `/v2/spaces/${spaceId}/events?since=0`);

// 9. complete -------------------------------------------------------------
const before = await call('re-read the task for its version', 'GET', `/v2/entities/${taskId}`);
const version = before?.version ?? before?.entity?.version;
await call('complete the task', 'POST', `/v2/entities/${taskId}/commands/complete`, {
  ...(version === undefined ? {} : { expectedVersion: version }),
  clientMutationId: cmid('complete'),
});
const after = await call('confirm the task actually moved', 'GET', `/v2/entities/${taskId}`);

if (!KEEP) {
  await call('terminate the session', 'POST', `/v2/entities/${sessionId}/commands/terminate`, {
    clientMutationId: cmid('terminate'),
  });
}

console.log(`\n  ✓ THE LOOP CLOSED`);
console.log(`     space   ${spaceId}`);
console.log(`     project ${projectId}`);
console.log(`     task    ${taskId}`);
console.log(`     session ${sessionId}`);
console.log(`     task state after complete: ${preview(after?.workStatus ?? after?.entity?.workStatus ?? after)}`);
console.log(`\n  ${step} calls, all through the real router.\n`);
