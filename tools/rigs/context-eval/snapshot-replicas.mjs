#!/usr/bin/env node
// FREEZE real tasks into fixtures/replicas-v2.json so every run replays the
// same replica shapes. READ-ONLY on the source: only `entity get` is issued.
//
//   SRC_CLI=tm8 node snapshot-replicas.mjs --manifests <live dataDir>/manifests <task-id>...
//
// The linked set is the one the real launch recorded (manifest.context.entries,
// group references), found in the newest manifest of a lane on that task —
// the same rule as context-measure/replicate.mjs. Copies are title + body
// only; a non-doc link is frozen as a doc with its content as the body and
// `substitutedFor` recorded.
import { execFileSync } from 'node:child_process';
import { readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const arg = (name) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : undefined;
};
const SRC = process.env.SRC_CLI ?? 'tm8';
const dir = arg('manifests');
const ids = process.argv.slice(2).filter((a) => /^[0-9a-f]{8}-/.test(a));
const src = (id) => JSON.parse(execFileSync(SRC, ['entity', 'get', id, '--full', '--format', 'json'], { encoding: 'utf8', maxBuffer: 64 << 20 }));

const manifests = readdirSync(dir).filter((f) => f.endsWith('.json')).map((f) => ({ f, t: statSync(join(dir, f)).mtimeMs })).sort((a, b) => b.t - a.t);
function launchOf(taskId) {
  for (const { f } of manifests) {
    const m = JSON.parse(readFileSync(join(dir, f), 'utf8'));
    if (m.context && (m.tasks ?? []).some((t) => (t.id ?? t.entityId) === taskId)) return m;
  }
  throw new Error(`no manifest with a context audit launched task ${taskId}`);
}
const frozen = (e) => {
  const c = e.content ?? {};
  if (e.kind === 'doc') return { kind: 'doc', title: e.title, body: c.body ?? '' };
  return { kind: 'doc', title: e.title, body: `# ${e.title}\n\n${JSON.stringify(c, null, 2)}\n`, substitutedFor: e.kind };
};
const replicas = [];
for (const taskId of ids) {
  const m = launchOf(taskId);
  const t = src(taskId);
  const c = t.content ?? {};
  const links = m.context.entries.filter((x) => x.group === 'references').map((e) => ({ link: e.link ?? 'relates_to', ...frozen(src(e.entityId)), source: e.entityId }));
  replicas.push({ key: `replica-${taskId.slice(0, 8)}`, source: taskId, title: t.title, content: { description: c.description ?? '', acceptanceCriteria: (c.acceptanceCriteria ?? []).map((a) => ({ ...a, done: false })) }, links });
  console.error(`${taskId}: ${links.length} links`);
}
writeFileSync(new URL('./fixtures/replicas-v2.json', import.meta.url), JSON.stringify({ frozenAt: new Date().toISOString(), replicas }, null, 2) + '\n');
