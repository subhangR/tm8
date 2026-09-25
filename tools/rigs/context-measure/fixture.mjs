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
// Link order is deliberate: each task relates_to its distractors first and
// its needle LAST, so under the referenceIndex cap the needle is the first
// entry to lose its header, then itself.

import { execFileSync } from 'node:child_process';
import { writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { TASKS, STRESS_LINKS, SKILLS, MEMORIES, SAMPLE_CSV, needleDoc, distractorDocs } from './fixture-data.mjs';

const CLI = process.env.TM8_CLI;
const PROJECT = process.env.PROJECT_ID;
const REPO = process.env.REPO;
const out = process.argv[process.argv.indexOf('--out') + 1] || 'fixture.json';
if (!CLI || !PROJECT || !REPO) throw new Error('set TM8_CLI, PROJECT_ID and REPO');

function tm8(...args) {
  const raw = execFileSync(CLI, [...args, '--format', 'json'], { encoding: 'utf8', maxBuffer: 64 << 20 });
  return JSON.parse(raw);
}
const idOf = (r) => r.id ?? r.entity?.id ?? r.data?.id;

function createDoc(doc) {
  return idOf(tm8('entity', 'create', 'doc', doc.title, '--content', JSON.stringify({ kind: 'doc', body: doc.body, format: 'markdown' })));
}

const fx = { skills: {}, memories: [], distractors: [], tasks: {} };

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

const dir = mkdtempSync(join(tmpdir(), 'i10a-'));
const csvPath = join(dir, 'sample-import.csv');
writeFileSync(csvPath, SAMPLE_CSV);

const pool = distractorDocs(STRESS_LINKS - 1);
fx.distractors = pool.map((d) => ({ title: d.title, id: createDoc(d) }));

for (const [i, task] of TASKS.entries()) {
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
  for (const d of distractors) tm8('edge', 'create', taskId, 'relates_to', d.id);
  tm8('edge', 'create', taskId, 'relates_to', needleId);
  const fileId = idOf(tm8('file', 'upload', csvPath, '--name', 'sample-import.csv', '--mime', 'text/csv', '--attach-to', taskId));
  for (const skillId of Object.values(fx.skills)) tm8('edge', 'create', taskId, 'equips', skillId);
  for (const memoryId of fx.memories) tm8('edge', 'create', taskId, 'remembers', memoryId);
  fx.tasks[task.key] = { id: taskId, needleId, fileId, fn: task.fn, links: distractors.length + 1, stress: !!task.stress };
  console.error(`task ${task.key} ${taskId} (${distractors.length + 1} docs)`);
}

writeFileSync(out, JSON.stringify(fx, null, 2));
console.error(`wrote ${out}`);
