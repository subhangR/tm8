// =============================================================================
// 327 — what an entity produced or has linked, as the tile's five counts.
//
// Asserted on the COUNTER ROW the tile reads, never on the edges alone: the
// owner's complaint was a tile that showed nothing although the work existed.
// =============================================================================

import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import {
  OWNER_URL,
  buildWorld,
  cmid,
  json,
  literal,
  ok,
  rows,
  scalar,
  uuid,
} from './helpers.mjs';

const w = buildWorld('outcounts');
const asPersona = { ...w.claimsA, 'tm8.actor_id': w.personaA };
const owner = { url: OWNER_URL };

const newTask = (title) =>
  json(`select public.create_task(${uuid(w.spaceA)}, ${literal(title)})`, { claims: w.claimsA }).entity.id;

const spawnOn = (taskIds, title) =>
  json(`select public.execution_spawn(${uuid(w.spaceA)}, ${uuid(w.personaA)},
     array[${taskIds.map((id) => uuid(id)).join(',')}]::uuid[], ${uuid(w.projectId)}, 'project', null, null,
     'worker', 'claude-opus-5', 'claude', ${literal(title)}, 'node-1', true, 64, null,
     ${literal(cmid('outcounts-spawn'))})`, { claims: w.claimsA }).entity.id;

/** A doc the persona makes, optionally attached to a task (create_document's own attach). */
const personaDoc = (title, attachTo = null) =>
  json(`select public.create_document(${uuid(w.spaceA)}, ${literal(title)}, ${uuid(w.personaA)}, 'body',
     'markdown', null, null, ${attachTo ? uuid(attachTo) : 'null'}, ${attachTo ? `'attached_to'` : 'null'},
     ${literal(cmid('outcounts-doc'))})`, { claims: asPersona }).entity.id;

const personaDrawing = (title) =>
  json(`select public.create_drawing_entity(${uuid(w.spaceA)}, ${literal(title)}, ${uuid(w.personaA)},
     'excalidraw', '[]'::jsonb, '{}'::jsonb, '{}'::jsonb, null, null, ${literal(cmid('outcounts-draw'))})`,
  { claims: asPersona }).entity.id;

/** What the server does after a create on a session's bearer. */
const recordFrom = (entityId, sessionOrChat) =>
  scalar(`select public.record_authored_from(${uuid(entityId)}, ${uuid(sessionOrChat)})`, { claims: asPersona });

const counts = (id) =>
  rows(`select linked_docs as docs, linked_pull_requests as prs, linked_artifacts as artifacts,
               linked_drawings as drawings, linked_memories as memories
          from public.entity_counters where entity_id = ${uuid(id)}`, { claims: w.claimsA })[0];

const zero = { docs: 0, prs: 0, artifacts: 0, drawings: 0, memories: 0 };

test('what a session makes counts on the session tile', () => {
  const task = newTask('session outputs');
  const session = spawnOn([task], 'makes things');
  assert.deepEqual(counts(session), zero);

  const doc = personaDoc('design notes');
  assert.ok(recordFrom(doc, session), 'the recorder links a doc the session teammate made');
  const drawing = personaDrawing('sketch');
  recordFrom(drawing, session);

  assert.deepEqual(counts(session), { ...zero, docs: 1, drawings: 1 });
});

test('a task counts its sessions\' outputs once, even when also linked directly', () => {
  const task = newTask('roll-up');
  const session = spawnOn([task], 'rolls up');

  // Made by the session AND attached to the task: one doc, counted once.
  const both = personaDoc('both routes', task);
  recordFrom(both, session);
  // Made by the session only.
  const viaSession = personaDoc('session only');
  recordFrom(viaSession, session);

  assert.deepEqual(counts(task), { ...zero, docs: 2 });
  assert.deepEqual(counts(session), { ...zero, docs: 2 });

  // The same doc also produced by the task: still one.
  ok(`select public.write_edge(${uuid(task)}, ${uuid(both)}, 'produces', '{}'::jsonb, ${uuid(w.memberA)},
       ${literal(cmid('outcounts-produces'))})`, { claims: w.claimsA });
  assert.equal(counts(task).docs, 2, 'a third route to the same doc adds nothing');
});

test('outputs made after a session\'s claim ended do not roll up to that task', () => {
  const task = newTask('windowed');
  const session = spawnOn([task], 'moves on');
  recordFrom(personaDoc('during'), session);
  assert.equal(counts(task).docs, 1);

  const claim = scalar(`select id from public.edges where src_id = ${uuid(session)}
                          and dst_id = ${uuid(task)} and type = 'working_on'`, { claims: w.claimsA });
  ok(`select internal.end_claims(array[${uuid(claim)}], 'released')`, owner);
  recordFrom(personaDoc('after'), session);

  assert.equal(counts(task).docs, 1, 'the task keeps only what was made inside the claim');
  assert.equal(counts(session).docs, 2, 'the session keeps everything it made');
});

test('a deleted doc stops counting, and a restore brings it back', () => {
  const task = newTask('deletes');
  const doc = personaDoc('doomed', task);
  assert.equal(counts(task).docs, 1);
  ok(`update public.entities set deleted_at = now() where id = ${uuid(doc)}`, owner);
  assert.equal(counts(task).docs, 0);
  ok(`update public.entities set deleted_at = null where id = ${uuid(doc)}`, owner);
  assert.equal(counts(task).docs, 1);
});

test('removing one of two routes keeps the count; removing the last drops it', () => {
  const task = newTask('routes');
  const doc = personaDoc('two routes', task);
  ok(`select public.write_edge(${uuid(task)}, ${uuid(doc)}, 'produces', '{}'::jsonb, ${uuid(w.memberA)},
       ${literal(cmid('outcounts-produces2'))})`, { claims: w.claimsA });
  ok(`delete from public.edges where src_id = ${uuid(doc)} and dst_id = ${uuid(task)} and type = 'attached_to'`, owner);
  assert.equal(counts(task).docs, 1, 'produces still links it');
  ok(`delete from public.edges where src_id = ${uuid(task)} and dst_id = ${uuid(doc)} and type = 'produces'`, owner);
  assert.equal(counts(task).docs, 0);
});

test('a linked PR counts on the task (tracks)', () => {
  const task = newTask('ships');
  ok(`select public.link_pull_request(${uuid(task)}, 'https://github.com/acme/app/pull/7', 'github',
       'acme/app', 7, null, null, ${literal(cmid('outcounts-pr'))})`, { claims: w.claimsA });
  assert.equal(counts(task).prs, 1);
});

test('what a chat makes is linked to the chat and counted there', () => {
  const chatId = randomUUID();
  const human = { ...w.claimsA, 'tm8.auth_kind': 'browser' };
  ok(`select public.start_chat(${uuid(chatId)}, ${uuid(w.spaceA)}, ${uuid(w.personaA)}, 'claude-opus-5',
       'anthropic', 'claude', 'ask', 'scratch', null, ${uuid(randomUUID())}, '/tmp/outcounts-chat',
       'chat outputs', 'hello', '{}'::uuid[], null, ${literal(cmid('outcounts-chat'))})`, { claims: human });

  const doc = personaDoc('chat-made doc');
  assert.ok(recordFrom(doc, chatId), 'the recorder accepts the chat as the provenance target');
  assert.equal(
    scalar(`select dst_id from public.edges where src_id = ${uuid(doc)} and type = 'authored_from'`, { claims: w.claimsA }),
    chatId,
  );
  assert.equal(counts(chatId).docs, 1);
});

test('the recorder still refuses an entity the session teammate did not make', () => {
  const task = newTask('foreign');
  const session = spawnOn([task], 'refuses');
  const humanDoc = json(`select public.create_document(${uuid(w.spaceA)}, 'human doc', ${uuid(w.memberA)},
     'body', 'markdown', null, null, null, null, ${literal(cmid('outcounts-human'))})`, { claims: w.claimsA }).entity.id;
  recordFrom(humanDoc, session);
  assert.equal(
    scalar(`select count(*) from public.edges where src_id = ${uuid(humanDoc)} and type = 'authored_from'`, { claims: w.claimsA }),
    '0',
    'no provenance for a member-made doc',
  );
  assert.equal(counts(session).docs, 0);
});

test('refresh_output_counts rebuilds a drifted row exactly', () => {
  const task = newTask('rebuild');
  personaDoc('one', task);
  personaDoc('two', task);
  ok(`update public.entity_counters set linked_docs = 99 where entity_id = ${uuid(task)}`, owner);
  ok(`select internal.refresh_output_counts(array[${uuid(task)}])`, owner);
  assert.equal(counts(task).docs, 2);
});
