#!/usr/bin/env node
// Build the I10a fixture on a DEV node (never 7778). Writes fixture.json.
//
//   TM8_CLI=/path/to/cli-wrapper PROJECT_ID=<id> REPO=<fixture repo> \
//     node fixture.mjs --out fixture.json
//
// TM8_CLI must already target the dev node and space (TM8_BASE_URL,
// TM8_AGENT_TOKEN, TM8_SPACE_ID). Docs are created WITHOUT authored headers;
// `headers.mjs` writes them for the authored-header pass.
//
// Link order is deliberate. A normal task relates_to its 4 distractors, then
// its needle. The stress task links STRESS_NEEDLE_AT - 1 distractors, the
// needle, then the rest: inside the spawn's 32-link read, but late enough
// that the referenceIndex cap (8 KiB) drops its header. A needle past the
// read cap (position 33+) is invisible to BOTH arms, so it cannot tell them
// apart.
//
// REUSE=<fixture.json> reuses its skills, memories and distractors, and
// (re)creates only the tasks named in ONLY=<key,key>.

import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { devCli } from './dev-cli.mjs';
import { TASKS, STRESS_LINKS, STRESS_NEEDLE_AT, SKILLS, MEMORIES, SAMPLE_CSV, needleDoc, distractorDocs } from './fixture-data.mjs';

const PROJECT = process.env.PROJECT_ID;
const REPO = process.env.REPO;
const out = process.argv[process.argv.indexOf('--out') + 1] || 'fixture.json';
if (!PROJECT || !REPO) throw new Error('set TM8_CLI, PROJECT_ID and REPO');
const tm8 = devCli();
const idOf = (r) => r.id ?? r.entity?.id ?? r.data?.id;

function createDoc(doc) {
  return idOf(tm8('entity', 'create', 'doc', doc.title, '--content', JSON.stringify({ kind: 'doc', body: doc.body, format: 'markdown' })));
}

const REUSE = process.env.REUSE ? JSON.parse(readFileSync(process.env.REUSE, 'utf8')) : null;
const ONLY = process.env.ONLY ? process.env.ONLY.split(',') : null;
const fx = REUSE ?? { skills: {}, memories: [], distractors: [], tasks: {} };

if (!REUSE) {
for (const [name, description] of SKILLS) {
  const body = `# ${name}\n\n${description}\n`;
  fx.skills[name] = idOf(tm8('skill', 'create', '--root', PROJECT, '--name', name, '--provider', 'claude', '--level', 'project', '--description', description, '--body', body));
}
// Project skills live in the checkout; lanes run in worktrees, so commit them.
execFileSync('git', ['-C', REPO, 'add', '.claude'], { stdio: 'inherit' });
execFileSync('git', ['-C', REPO, '-c', 'user.email=fixture@i10a', '-c', 'user.name=fixture', 'commit', '-qm', 'fixture skills'], { stdio: 'inherit' });

for (const [statement, subjectScope, mechanism] of MEMORIES) {
  const content = { kind: 'memory', statement, mechanism, subjectScope, doesNotEstablish: 'anything about repos other than ledger-lite', measuredAt: null };
  fx.memories.push(idOf(tm8('entity', 'create', 'memory', statement.slice(0, 80), '--content', JSON.stringify(content))));
}

const pool = distractorDocs(STRESS_LINKS - 1);
fx.distractors = pool.map((d) => ({ title: d.title, id: createDoc(d) }));
}

const dir = mkdtempSync(join(tmpdir(), 'i10a-'));
const csvPath = join(dir, 'sample-import.csv');
writeFileSync(csvPath, SAMPLE_CSV);

for (const [i, task] of TASKS.entries()) {
  if (ONLY && !ONLY.includes(task.key)) continue;
  const needle = needleDoc(task);
  const needleId = createDoc(needle);
  const distractors = task.stress ? fx.distractors : [0, 1, 2, 3].map((k) => fx.distractors[(i * 4 + k) % fx.distractors.length]);
  const content = {
    description:
      `Add \`${task.fn}\` to src/ledger.js as a named export, implementing the rule in the linked spec doc exactly. ` +
      `Add a node --test case for it in test/. Commit on your branch (there is no remote, so do not push or open a PR). ` +
      `Then post a closeout message on this task and tick the acceptance criteria.`,
    acceptanceCriteria: [
      { id: 'ac_1', done: false, text: `\`${task.fn}\` is exported from src/ledger.js and implements the linked spec` },
      { id: 'ac_2', done: false, text: 'a test for it passes under npm test' },
      { id: 'ac_3', done: false, text: 'the change is committed on the lane branch' },
    ],
  };
  const taskId = idOf(tm8('entity', 'create', 'task', task.title, '--content', JSON.stringify(content)));
  const at = task.stress ? STRESS_NEEDLE_AT - 1 : distractors.length;
  for (const d of distractors.slice(0, at)) tm8('edge', 'create', taskId, 'relates_to', d.id);
  tm8('edge', 'create', taskId, 'relates_to', needleId);
  for (const d of distractors.slice(at)) tm8('edge', 'create', taskId, 'relates_to', d.id);
  const fileId = idOf(tm8('file', 'upload', csvPath, '--name', 'sample-import.csv', '--mime', 'text/csv', '--attach-to', taskId));
  for (const skillId of Object.values(fx.skills)) tm8('edge', 'create', taskId, 'equips', skillId);
  for (const memoryId of fx.memories) tm8('edge', 'create', taskId, 'remembers', memoryId);
  // linkedIds: everything the task links, so run-lane can count a read of any
  // of them the index did not carry as a miss (not only the needle's).
  fx.tasks[task.key] = { id: taskId, needleId, fileId, fn: task.fn, links: distractors.length + 1, linkedIds: [...distractors.map((d) => d.id), needleId, fileId], needleAt: at + 1, stress: !!task.stress };
  console.error(`task ${task.key} ${taskId} (${distractors.length + 1} docs)`);
}

writeFileSync(out, JSON.stringify(fx, null, 2));
console.error(`wrote ${out}`);
