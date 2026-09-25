#!/usr/bin/env node
// Copy real tasks, and what their launch linked, onto the dev node, so the
// bytes arms also run on real link shapes (§7.1, the "median lane" claim).
//
//   SRC_CLI=tm8 TM8_CLI=<dev-node wrapper> node replicate.mjs \
//     --manifests <live dataDir>/manifests --out replicas.json <task-id>...
//
// READ-ONLY on the source: only `entity get` is issued through SRC_CLI. The
// linked set is the one the real launch recorded (manifest.context.entries,
// group references), found in the newest manifest of a lane on that task.
// Copies are title + body only, derived headers only (real entities carry
// almost no authored headers yet). A `form` has no generic create, so it is
// copied as a doc with the same title and its questions as the body; the
// row records the substitution.

import { execFileSync } from 'node:child_process';
import { readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const arg = (name) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : undefined;
};
const SRC = process.env.SRC_CLI ?? 'tm8';
const DST = process.env.TM8_CLI;
const dir = arg('manifests');
const ids = process.argv.slice(2).filter((a) => /^[0-9a-f]{8}-/.test(a));

const run = (cli, args) => JSON.parse(execFileSync(cli, [...args, '--format', 'json'], { encoding: 'utf8', maxBuffer: 64 << 20 }));
const src = (id) => run(SRC, ['entity', 'get', id, '--full']);
const dst = (...a) => run(DST, a);
const idOf = (r) => r.id ?? r.entity?.id;

const manifests = readdirSync(dir)
  .filter((f) => f.endsWith('.json'))
  .map((f) => ({ f, t: statSync(join(dir, f)).mtimeMs }))
  .sort((a, b) => b.t - a.t);

function launchOf(taskId) {
  for (const { f } of manifests) {
    const m = JSON.parse(readFileSync(join(dir, f), 'utf8'));
    if (m.context && (m.tasks ?? []).some((t) => (t.id ?? t.entityId) === taskId)) return m;
  }
  throw new Error(`no manifest with a context audit launched task ${taskId}`);
}

function copy(entity) {
  const c = entity.content ?? {};
  if (entity.kind === 'task') {
    const content = { description: c.description ?? '', acceptanceCriteria: (c.acceptanceCriteria ?? []).map((a) => ({ ...a, done: false })) };
    return { id: idOf(dst('entity', 'create', 'task', entity.title, '--content', JSON.stringify(content))), kind: 'task' };
  }
  if (entity.kind === 'doc') {
    return { id: idOf(dst('entity', 'create', 'doc', entity.title, '--content', JSON.stringify({ kind: 'doc', body: c.body ?? '', format: 'markdown' }))), kind: 'doc' };
  }
  const body = `# ${entity.title}\n\n${JSON.stringify(c, null, 2)}\n`;
  return { id: idOf(dst('entity', 'create', 'doc', entity.title, '--content', JSON.stringify({ kind: 'doc', body, format: 'markdown' }))), kind: 'doc', substitutedFor: entity.kind };
}

const out = {};
for (const taskId of ids) {
  const m = launchOf(taskId);
  const task = src(taskId);
  const copyTask = copy(task);
  const links = [];
  for (const e of m.context.entries.filter((x) => x.group === 'references')) {
    const c = copy(src(e.entityId));
    if (e.link === 'attached_to') dst('edge', 'create', c.id, 'attached_to', copyTask.id);
    else dst('edge', 'create', copyTask.id, e.link ?? 'relates_to', c.id);
    links.push({ source: e.entityId, copy: c.id, kind: e.kind, link: e.link, ...(c.substitutedFor ? { substitutedFor: c.substitutedFor } : {}) });
  }
  out[`replica-${taskId.slice(0, 8)}`] = { id: copyTask.id, source: taskId, sourceSession: m.sessionId, title: task.title, links, needleId: null, fileId: null };
  console.error(`replica ${taskId} -> ${copyTask.id} (${links.length} links)`);
}
writeFileSync(arg('out'), JSON.stringify({ tasks: out, distractors: [] }, null, 2));
