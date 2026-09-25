// context-eval fixture content, v2. Pure data: no I/O. The needle tasks, the
// distractors, skills, memories and CSV are IMPORTED from context-measure's
// fixture (the §7.1 fixture, #799), so the needle family stays comparable with
// I10a's numbers. This file adds the v2 families: stress30, memory, multiturn.
//
// `node build-fixture.mjs` turns this + fixtures/replicas-v2.json into
// fixtures/fixture-v2.json, the versioned file every run reads.

import { TASKS, SKILLS, MEMORIES, SAMPLE_CSV, needleDoc, distractorDocs, STRESS_LINKS, STRESS_NEEDLE_AT } from '../context-measure/fixture-data.mjs';

export const SCHEMA_VERSION = 2;

const byKey = Object.fromEntries(TASKS.map((t) => [t.key, t]));

const DESCRIPTION = (fn) =>
  `Add \`${fn}\` to src/ledger.js as a named export, implementing the rule in the linked spec doc exactly. ` +
  `Add a node --test case for it in test/. Commit on your branch (there is no remote, so do not push or open a PR). ` +
  `Then post a closeout message on this task and tick the acceptance criteria.`;
const CRITERIA = (fn) => [
  { id: 'ac_1', done: false, text: `\`${fn}\` is exported from src/ledger.js and implements the linked spec` },
  { id: 'ac_2', done: false, text: 'a test for it passes under npm test' },
  { id: 'ac_3', done: false, text: 'the change is committed on the lane branch' },
];

/** One task template: docs in LINK ORDER (the needle's position is `needleAt`, 1-based). */
function needleTask(src, { key = src.key, family = 'needle', links = 5, needleAt = 5, memories = 'base', title = src.title } = {}) {
  const pool = distractorDocs(Math.max(links - 1, 4));
  const docs = [];
  let d = 0;
  for (let pos = 1; pos <= links; pos++) {
    if (pos === needleAt) docs.push({ role: 'needle', ...needleDoc(src) });
    else docs.push({ role: 'distractor', ...pool[d++ % pool.length] });
  }
  return {
    key, family, title, fn: src.fn,
    content: { description: DESCRIPTION(src.fn), acceptanceCriteria: CRITERIA(src.fn) },
    docs, needleAt, file: true, skills: true, memories,
    checks: src.check,
    headerCarriesFact: !!src.headerCarriesFact,
  };
}

// Q1 (design §10): 12 memories totalling ~14 KiB, over the 12 KiB memoryInjection
// cap, under the 32 KiB prompt ceiling with the index OFF (memories then inject
// whole; manifest.ts:1926-1928). The ALIAS memory is created first, so under
// the no-rank collapse order (task-remembered, unverified, oldest first) it is
// the first to collapse into the index. Only a lane that expands it can pass
// the alias check.
const LONG = (topic, i) =>
  `${topic}. ` +
  `Recorded by the finance tooling team while maintaining ledger-lite, the small CSV ledger. This note is kept because it was learned the hard way and ` +
  `nobody wants to re-learn it: it covers what was tried, what broke, and what the team now does instead. It applies to every helper in src/ledger.js ` +
  `and to the tests under test/. It does not state any product rule; product rules live in the tm8 docs linked to each task. Detail ${i}: the note was ` +
  `reviewed by the finance lead, confirmed against two real bank exports, and has not changed since the March review. Treat it as background, not as a spec. ` +
  `When in doubt, prefer the linked spec doc over this note, and quote the doc in your closeout so the reviewer can check the rule you implemented. ` +
  `The team keeps these notes short on purpose; if you find one wrong, say so in the closeout rather than silently ignoring it. ` +
  `Nothing in this note overrides a linked spec; it exists so a new lane does not repeat an old mistake, and it is safe to skim. `.repeat(2);
export const HEAVY_MEMORIES = [
  { statement: 'Every helper added to src/ledger.js must ALSO be exported under an alias: the same name with the digit 2 appended (fee -> fee2, categoryOf -> categoryOf2), behaving identically. The accounting integration imports the alias. ' + LONG('Alias exports for the accounting integration', 0), subjectScope: 'export aliases', mechanism: 'accounting integration imports <name>2', alias: true },
  ...['Import performance on large exports', 'Why parseCsv keeps amounts as numbers', 'Test naming in test/', 'Commit granularity on small repos', 'How the March review changed edge-case handling', 'Why there is no build step', 'Error objects carry a string code', 'Dates stay ISO internally', 'Closeout etiquette with the finance lead', 'No new npm packages', 'Where product rules live'].map((topic, i) => ({ statement: LONG(topic, i + 1), subjectScope: topic.toLowerCase(), mechanism: 'team practice' })),
];

export const TURN = {
  // Injected at the lane's first idle (mid-lane, while the session is alive).
  message: (fn) => `Change request from the finance lead: also export \`${fn}Strict\` from src/ledger.js. It behaves exactly like \`${fn}\` but throws an Error with code \`E_INPUT_12\` when its first argument is undefined or null. Add a test, commit, and post a short closeout on this task when done.`,
  checks: (fn, sample) => [
    [`(() => { try { ${fn}Strict(undefined); return 'no-throw'; } catch (e) { return e.code; } })()`, 'E_INPUT_12'],
    [`${fn}Strict(${sample[0]})`, sample[1]],
  ],
};

export const TASK_TEMPLATES = {
  fee: needleTask(byKey.fee),
  category: needleTask(byKey.category),
  rounding: needleTask({ ...byKey.rounding, stress: false }),
  stress30: needleTask(byKey.limit, { key: 'stress30', family: 'stress', links: 30, needleAt: 20, title: 'Enforce the single-transaction limit in ledger-lite (30 linked docs)' }),
  stress60: needleTask(byKey.rounding, { key: 'stress60', family: 'stress', links: STRESS_LINKS, needleAt: STRESS_NEEDLE_AT, title: 'Add a rounded balance helper to ledger-lite (60 linked docs)' }),
  'mem-fee': { ...needleTask(byKey.fee, { key: 'mem-fee', family: 'memory', memories: 'heavy' }), checks: [...byKey.fee.check, ['fee2(1000)', 3.5], ['fee2(100)', 0.4]] },
  'turn-date': { ...needleTask(byKey.date, { key: 'turn-date', family: 'multiturn' }), turn: { message: TURN.message('parseDate'), checks: TURN.checks('parseDate', ["'03.02.2026'", '2026-02-03']) } },
};

export const RUBRIC_ITEMS = {
  needle: ['committed', 'checks', 'closeout', 'ticked'],
  stress: ['committed', 'checks', 'closeout', 'ticked'],
  memory: ['committed', 'checks', 'closeout', 'ticked', 'aliasCheck'],
  multiturn: ['committed', 'checks', 'closeout', 'ticked', 'turnChecks', 'resumed'],
  replica: ['committed', 'closeout', 'ticked'],
};

export function fixtureContent(replicas) {
  return {
    schemaVersion: SCHEMA_VERSION,
    skills: SKILLS,
    memories: { base: MEMORIES.map(([statement, subjectScope, mechanism]) => ({ statement, subjectScope, mechanism })), heavy: HEAVY_MEMORIES },
    sampleCsv: SAMPLE_CSV,
    tasks: { ...TASK_TEMPLATES, ...Object.fromEntries((replicas ?? []).map((r) => [r.key, { ...r, family: 'replica', checks: [] }])) },
  };
}
