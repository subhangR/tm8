/**
 * SEED A SPACE IN THE SHAPE OF A REAL ONE, for `measure-launch-open.mjs`.
 *
 * The launch card's open time depends on how much the client holds (every
 * graph event re-derives the launch sources over the whole entity store) and
 * on what `launch.defaults` returns for the subject, so an empty dev space
 * measures nothing. The counts below are the tm8 space's own on 2026-10-28
 * (read-only `count(*)` per kind on the prod database): 1148 tasks, 1461
 * docs, 159 skills, 44 memories, 22 teammates, 21 stories. Messages are seeded
 * at a sixth of the real 13268 (only the subject's thread is read by the
 * card's host), and sessions, commits and PRs not at all: the card reads none.
 *
 * The subject task carries a launch that is "full" for this space: the
 * teammate the card opens on remembers 4 memories and equips 5 skills, the
 * task remembers 2 more and relates to 6 docs and 2 tasks — so every strip
 * group has rows.
 *
 * Deterministic (seeded PRNG), so BEFORE and AFTER run against the same shape.
 * RESUMABLE: each kind is topped up to its count from what the space already
 * holds, and the subject's launch is wired once (a re-run finds the subject
 * and stops there). Concurrency is kept low on purpose: the dev slot's
 * database shares a Postgres cluster with other lanes.
 * Writes ONLY to the server named by TM8_BASE_URL, which must not be a prod
 * port; it refuses 7777 and 17777 outright.
 *
 * Usage:
 *   TM8_BASE_URL=http://127.0.0.1:4761 node e2e/launch-open-seed.mjs <spaceId> <skillRootFolderId>
 * Prints a JSON line with the subject task id and the teammate id.
 */
import { randomUUID } from 'node:crypto';

const BASE = process.env.TM8_BASE_URL ?? '';
const [spaceId, skillRoot] = process.argv.slice(2);
if (!BASE || /:(7777|17777)\b/.test(BASE)) {
  console.error('TM8_BASE_URL must name a dev-slot server (never 7777/17777).');
  process.exit(2);
}
if (!spaceId || !skillRoot) {
  console.error('usage: node e2e/launch-open-seed.mjs <spaceId> <skillRootFolderId>');
  process.exit(2);
}

const SHAPE = { tasks: 1148, docs: 1461, skills: 159, memories: 44, teammates: 22, stories: 21, messages: 2200 };
const CONCURRENCY = 3;

let seed = 0x5eed;
const rand = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
const pick = (list) => list[Math.floor(rand() * list.length)];
const WORDS = 'launch card cache teammate subject defaults strip memory skill reference profile harness worktree node space session spawn merge stale fresh render frame loader event graph port seam budget index prompt'.split(' ');
const sentence = (n) => Array.from({ length: n }, () => pick(WORDS)).join(' ');
const paragraph = (n) => Array.from({ length: n }, () => `${sentence(12)}.`).join(' ');

/** One request. A command (`mutation`, the default) carries a fresh client mutation id; a read must not. */
async function call(method, path, body, { mutation = method !== 'GET' } = {}) {
  for (let attempt = 0; ; attempt += 1) {
    const res = await fetch(`${BASE}${path}`, {
      method,
      headers: { 'content-type': 'application/json' },
      ...(body ? { body: JSON.stringify(mutation ? { clientMutationId: randomUUID(), ...body } : body) } : {}),
    });
    if (res.ok) return (await res.json()).data;
    if ((res.status === 429 || res.status === 503) && attempt < 8) {
      await new Promise((r) => setTimeout(r, 200 * (attempt + 1)));
      continue;
    }
    throw new Error(`${method} ${path} → ${res.status} ${(await res.text()).slice(0, 300)}`);
  }
}

async function pool(items, fn) {
  const out = new Array(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: CONCURRENCY }, async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i], i);
    }
  }));
  return out;
}

/** Every live entity of a kind already in the space, oldest first (the node pages newest first). */
async function existing(kind) {
  const ids = [];
  let cursor;
  do {
    const page = (await call('POST', '/v2/collections/query', { spaceId, kinds: [kind], limit: 200, sort: 'createdAt_desc', ...(cursor ? { cursor } : {}) }, { mutation: false })).page;
    for (const item of page.items) ids.push({ id: item.id, title: item.title });
    cursor = page.nextCursor;
  } while (cursor);
  return ids.reverse();
}

/** Top a kind up to `count`: the ones already there, then new ones made by `make(i)` for the missing indexes. */
async function topUp(kind, count, make, keep = () => true) {
  const have = (await existing(kind)).filter(keep).map((row) => row.id);
  const made = await pool(Array.from({ length: Math.max(0, count - have.length) }, (_, i) => have.length + i), make);
  return [...have, ...made];
}

const entity = (kind, title, content) => call('POST', '/v2/entities', { spaceId, kind, title, ...(content ? { content } : {}) })
  .then((d) => d.entity.id);
const edge = (srcId, type, dstId) => call('POST', '/v2/edges', { srcId, type, dstId });

const t0 = Date.now();
const MODELS = [
  ['claude-code', 'claude-opus-5-5[1m]', 'worker'], ['claude-code', 'claude-opus-5-5[1m]', 'coordinator'],
  ['claude-code', 'claude-opus-5-5[1m]', 'dispatcher'], ['claude-code', 'claude-opus-5', 'worker'],
  ['claude-code', 'claude-sonnet-5', 'worker'], ['claude-code', 'claude-fable-5-1[1m]', 'worker'],
  ['codex', 'gpt-6-astra', 'worker'],
];
const teammates = await topUp('team_member', SHAPE.teammates, (i) => {
  const [agentTool, model, mode] = MODELS[i % MODELS.length];
  return entity('team_member', `Teammate ${String(i + 1).padStart(2, '0')} ${model}`, { agentTool, model, mode });
}, (row) => row.title.startsWith('Teammate '));
/* The teammate the card opens on: with no launch recents in a fresh browser,
   the roster's alphabetical first (`orderTeammatesByRecency`) — so that is the
   one whose memories and skills the subject's launch carries. */
const byName = new Intl.Collator(undefined, { sensitivity: 'base', numeric: true });
const teammate = (await existing('team_member')).sort((a, b) => byName.compare(a.title, b.title))[0].id;

const docs = await topUp('doc', SHAPE.docs, (i) =>
  entity('doc', `Doc ${i + 1}: ${sentence(5)}`, { kind: 'doc', body: `# ${sentence(4)}\n\n${paragraph(10)}\n\n${paragraph(8)}`, format: 'markdown' }));

const SUBJECT_TITLE = 'Launch card opens instantly (measurement subject)';
const tasks = await topUp('task', SHAPE.tasks, (i) =>
  entity('task', `Task ${i + 1}: ${sentence(6)}`, {
    description: paragraph(4),
    acceptanceCriteria: i % 3 === 0 ? [{ id: 'ac1', done: false, text: sentence(8) }, { id: 'ac2', done: i % 2 === 0, text: sentence(8) }] : [],
  }));

const already = (await existing('task')).find((row) => row.title === SUBJECT_TITLE);
if (already) {
  console.log(JSON.stringify({ spaceId, subjectId: already.id, teammateId: teammate, note: 'already seeded' }));
  process.exit(0);
}
const subject = await entity('task', SUBJECT_TITLE, {
  description: `${paragraph(14)}\n\n${paragraph(14)}`,
  acceptanceCriteria: [{ id: 'ac1', done: false, text: 'Opens in under 100 ms' }],
});

const memories = await topUp('memory', SHAPE.memories, (i) => {
  const statement = `Memory ${i + 1}: ${sentence(9)}`;
  return entity('memory', statement, { statement, mechanism: sentence(8), subjectScope: `packages/${pick(WORDS)}`, doesNotEstablish: sentence(6) });
});

await topUp('story', SHAPE.stories, (i) => entity('story', `Story ${i + 1}: ${sentence(4)}`, { description: paragraph(2) }));

/* Skills: the node's own roots are already scanned into the space by the
   first create; top up to the real count inside the lane's project folder. */
const existingSkills = await call('GET', `/v2/spaces/${spaceId}/skills?limit=500`);
const have = existingSkills.items?.length ?? 0;
const skillIds = (existingSkills.items ?? []).map((s) => s.id);
for (let i = have; i < SHAPE.skills; i += 1) {
  const created = await call('POST', `/v2/spaces/${spaceId}/skills`, {
    root: skillRoot, name: `shape-skill-${i + 1}`, description: `Use when ${sentence(10)}`, body: `# Skill ${i + 1}\n\n${paragraph(5)}`,
  });
  skillIds.push(created.id);
}

/* The subject's launch: what `launch.defaults` will return for it. */
for (const m of memories.slice(0, 4)) await edge(teammate, 'remembers', m);
for (const m of memories.slice(4, 6)) await edge(subject, 'remembers', m);
for (const s of skillIds.slice(0, 5)) await call('POST', `/v2/skills/${s}/equip`, { teamMemberId: teammate });
for (const d of docs.slice(0, 6)) await edge(subject, 'relates_to', d);
for (const t of tasks.slice(0, 2)) await edge(subject, 'relates_to', t);

/* The rest of the space's edges, at its own counts (relates_to 98, depends_on 287, remembers 17). */
await pool(Array.from({ length: 90 }, (_, i) => i), (i) => edge(tasks[(i * 7) % tasks.length], 'relates_to', docs[(i * 13) % docs.length]));
await pool(Array.from({ length: 280 }, (_, i) => i), (i) => edge(tasks[(i * 11 + 3) % tasks.length], 'depends_on', tasks[(i * 17 + 5) % tasks.length]).catch(() => null));
await pool(Array.from({ length: 11 }, (_, i) => i), (i) => edge(teammates[1 + (i % 5)], 'remembers', memories[6 + i]));

/* Messages: the subject's own thread, then a spread over other tasks. */
const anchors = [...Array.from({ length: 60 }, () => subject), ...Array.from({ length: SHAPE.messages - 60 }, (_, i) => tasks[(i * 5) % tasks.length])];
await pool(anchors, (anchor) => call('POST', '/v2/messages', { anchorIds: [anchor], body: paragraph(2) }));

console.log(JSON.stringify({ spaceId, subjectId: subject, teammateId: teammate, teammates: teammates.length, docs: docs.length, tasks: tasks.length + 1, memories: memories.length, skills: skillIds.length, seconds: Math.round((Date.now() - t0) / 1000) }));
