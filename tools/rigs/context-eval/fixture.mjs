#!/usr/bin/env node
// Build the TEMPLATE entities for fixtures/fixture-v2.json on ONE eval node.
//
//   node fixture.mjs --node <port> [--force]
//
// Writes fixtures/node-<port>.json: every id the rig needs on that node, plus
// each template task's edges in creation order, so lanes.mjs can copy a task
// per lane (a lane NEVER runs on a template: reviewer finding on #809, the
// template would carry earlier lanes' closeouts). Skipped when the node file
// already matches the fixture's contentHash (use --force to rebuild).
//
// On an `index-authored` node the fixture docs get AUTHORED headers (same
// text as context-measure/headers.mjs); every other arm keeps derived headers
// only. The node file records which, and lanes.mjs refuses a mismatch.

import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { devCli } from '../context-measure/dev-cli.mjs';
import { nodeRecord } from './node-registry.mjs';

const arg = (name) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : undefined;
};
const port = Number(arg('node'));
if (!port) throw new Error('usage: node fixture.mjs --node <port> [--force]');
const node = nodeRecord(port);
const fx = JSON.parse(readFileSync(new URL('./fixtures/fixture-v2.json', import.meta.url), 'utf8'));
const outPath = new URL(`./fixtures/node-${port}.json`, import.meta.url);
if (existsSync(outPath) && !process.argv.includes('--force')) {
  const prev = JSON.parse(readFileSync(outPath, 'utf8'));
  if (prev.contentHash === fx.contentHash && prev.authoredHeaders === (node.arm === 'index-authored')) {
    console.error(`fixture on node ${port} is current (hash ${fx.contentHash}, authoredHeaders=${prev.authoredHeaders}); --force to rebuild`);
    process.exit(0);
  }
}
process.env.TM8_CLI = node.cli;
process.env.TM8_SPACE_ID = node.spaceId;
const tm8 = devCli();
const idOf = (r) => r.id ?? r.entity?.id ?? r.data?.id;
const createDoc = (title, body) => idOf(tm8('entity', 'create', 'doc', title, '--content', JSON.stringify({ kind: 'doc', body, format: 'markdown' })));
const authored = node.arm === 'index-authored';

const out = { schemaVersion: fx.schemaVersion, contentHash: fx.contentHash, port, arm: node.arm, authoredHeaders: authored, builtAt: new Date().toISOString(), skills: {}, memories: { base: [], heavy: [] }, docsByTitle: {}, fileId: null, tasks: {} };

// Skills: project-level, in the fixture repo's checkout; lanes run in worktrees, so commit them.
for (const [name, description] of fx.skills) {
  out.skills[name] = idOf(tm8('skill', 'create', '--root', node.projectId, '--name', name, '--provider', 'claude', '--level', 'project', '--description', description, '--body', `# ${name}\n\n${description}\n`));
}
execFileSync('git', ['-C', node.repo, 'add', '.claude'], { stdio: 'inherit' });
try {
  execFileSync('git', ['-C', node.repo, '-c', 'user.email=fixture@ctx-eval', '-c', 'user.name=fixture', 'commit', '-qm', 'fixture skills'], { stdio: 'inherit' });
} catch {
  /* nothing to commit: skills already committed */
}

// Memories. HEAVY are created in list order: heavy[0] (the alias fact) is the
// OLDEST, so it collapses first under Q1's no-rank order.
const createMemory = (m) => idOf(tm8('entity', 'create', 'memory', m.statement.slice(0, 80), '--content', JSON.stringify({ kind: 'memory', statement: m.statement, mechanism: m.mechanism, subjectScope: m.subjectScope, doesNotEstablish: 'anything about repos other than ledger-lite', measuredAt: null })));
for (const m of fx.memories.base) out.memories.base.push(createMemory(m));
for (const m of fx.memories.heavy) out.memories.heavy.push(createMemory(m));

// Docs: one entity per distinct title (distractors are shared across tasks, needles are per task).
const docId = (doc) => {
  const key = doc.role === 'needle' ? `needle:${doc.title}` : doc.title;
  if (!out.docsByTitle[key]) {
    out.docsByTitle[key] = createDoc(doc.title, doc.body);
    if (authored) {
      const h = doc.role === 'needle' && doc.header
        ? doc.header
        : { whenToUse: `When you need the team's ${doc.title.toLowerCase()}`, summary: `Informational notes on ${doc.title.toLowerCase()}. Defines no ledger-lite helper behaviour.` };
      tm8('entity', 'header', 'set', out.docsByTitle[key], '--when-to-use', h.whenToUse, '--summary', h.summary);
    }
  }
  return out.docsByTitle[key];
};

// The attached file, once; a copy gets an `attached_to` edge to it.
const dir = mkdtempSync(join(tmpdir(), 'ctx-eval-'));
writeFileSync(join(dir, 'sample-import.csv'), fx.sampleCsv);

for (const [key, t] of Object.entries(fx.tasks)) {
  const content = { description: t.content.description, acceptanceCriteria: (t.content.acceptanceCriteria ?? []).map((c) => ({ ...c, done: false })) };
  const templateId = idOf(tm8('entity', 'create', 'task', t.title, '--content', JSON.stringify(content)));
  // Edges in creation order; TASK stands for the (template or copied) task id.
  const edges = [];
  let needleId = null;
  const linkedIds = [];
  if (t.family === 'replica') {
    for (const l of t.links) {
      const id = createDoc(l.title, l.body);
      linkedIds.push(id);
      edges.push(l.link === 'attached_to' ? { src: id, type: 'attached_to', dst: 'TASK' } : { src: 'TASK', type: l.link ?? 'relates_to', dst: id });
    }
  } else {
    for (const doc of t.docs) {
      const id = docId(doc);
      if (doc.role === 'needle') needleId = id;
      linkedIds.push(id);
      edges.push({ src: 'TASK', type: 'relates_to', dst: id });
    }
    if (t.file) {
      out.fileId ??= idOf(tm8('file', 'upload', join(dir, 'sample-import.csv'), '--name', 'sample-import.csv', '--mime', 'text/csv', '--attach-to', templateId));
      linkedIds.push(out.fileId);
      edges.push({ src: out.fileId, type: 'attached_to', dst: 'TASK' });
    }
    if (t.skills) for (const id of Object.values(out.skills)) edges.push({ src: 'TASK', type: 'equips', dst: id });
    const mems = t.memories === 'heavy' ? out.memories.heavy : out.memories.base;
    for (const id of mems) edges.push({ src: 'TASK', type: 'remembers', dst: id });
  }
  for (const e of edges) {
    if (e.type === 'attached_to' && e.src === out.fileId) continue; // the upload attached it to the template already
    tm8('edge', 'create', e.src === 'TASK' ? templateId : e.src, e.type, e.dst === 'TASK' ? templateId : e.dst);
  }
  out.tasks[key] = { templateId, family: t.family, title: t.title, content, fn: t.fn ?? null, needleId, needleAt: t.needleAt ?? null, fileId: t.file ? out.fileId : null, linkedIds, edges, checks: t.checks ?? [], turn: t.turn ?? null, headerCarriesFact: !!t.headerCarriesFact, memoryIds: t.family === 'replica' ? [] : (t.memories === 'heavy' ? out.memories.heavy : out.memories.base) };
  console.error(`template ${key} ${templateId} (${linkedIds.length} links, ${edges.length} edges)`);
}
writeFileSync(outPath, JSON.stringify(out, null, 2) + '\n');
console.error(`wrote fixtures/node-${port}.json (authoredHeaders=${authored})`);
