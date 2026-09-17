// =============================================================================
// The `drawing` kind (194), end to end, through the RPC doors only.
//
// A drawing is an Excalidraw scene stored in its own three parts — elements,
// appState, files — under the ordinary entity envelope. Editing is create +
// version-guarded patch: single-writer by ruling D4, so the stale-patch case
// below is the whole concurrency story, not a placeholder for one.
//
// Every step asserts the CONTENT of what came back. `internal.entity_content`
// falls through to '{}'::jsonb for a kind it does not know, and that failure
// is INVISIBLE to success-only assertions — the 011/091 lesson that 135's
// own header calls out. Step 1 exists to make that arm impossible to omit.
// =============================================================================

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  OWNER_URL,
  buildWorld,
  cmid,
  denied,
  json,
  literal,
  scalar,
  uuid,
} from './helpers.mjs';

const w = buildWorld('drawing');

const commandEntity = (id) => json(`select internal.command_entity(${uuid(id)})`, { url: OWNER_URL });

// Two rectangles and an arrow — the shape a real Excalidraw save has, trimmed
// to the members the row actually round-trips.
const RECT = (id, x) => ({
  id, type: 'rectangle', x, y: 40, width: 120, height: 60,
  angle: 0, strokeColor: '#1e1e1e', backgroundColor: 'transparent',
  fillStyle: 'solid', strokeWidth: 2, roughness: 1, opacity: 100,
  seed: 1234, version: 1, versionNonce: 5678, isDeleted: false,
});

const state = {};

test('step 1 — create a drawing and its CONTENT resolves (the entity_content arm)', () => {
  const elements = JSON.stringify([RECT('a', 0), RECT('b', 200)]);
  const created = json(
    `select public.create_drawing_entity(${uuid(w.spaceA)}, 'Auth sketch', null,
       'excalidraw', ${literal(elements)}::jsonb,
       '{"viewBackgroundColor":"#ffffff","gridSize":null}'::jsonb, '{}'::jsonb,
       null, null, ${literal(cmid('drawing-create'))})`,
    { claims: w.claimsA },
  );
  state.drawing = created.entity;

  assert.equal(state.drawing.kind, 'drawing');
  assert.equal(state.drawing.version, 1);
  // THE assertion this suite exists for: a missing entity_content arm makes
  // every one of these undefined while the create still reports success.
  assert.equal(state.drawing.content.title, 'Auth sketch', 'drawing content must resolve (011/091)');
  assert.equal(state.drawing.content.format, 'excalidraw');
  assert.equal(state.drawing.content.elements.length, 2);
  assert.equal(state.drawing.content.elements[0].type, 'rectangle');
  assert.equal(state.drawing.content.app_state.viewBackgroundColor, '#ffffff');
  assert.deepEqual(state.drawing.content.files, {});

  // The kind is registered as core, which is what puts it in the palette.
  assert.equal(
    scalar(`select origin from public.entity_kinds where kind = 'drawing' and space_id is null`,
      { url: OWNER_URL }),
    'core',
  );
});

test('step 2 — a version-guarded patch merges, bumps the version, and refuses staleness', () => {
  const grown = JSON.stringify([RECT('a', 0), RECT('b', 200), RECT('c', 400)]);
  const patched = json(
    `select public.update_drawing_entity(${uuid(state.drawing.id)}, 1, null,
       null, null, ${literal(grown)}::jsonb, null, null,
       ${literal(cmid('drawing-grow'))})`,
    { claims: w.claimsA },
  );
  assert.equal(patched.entity.version, 2);
  assert.equal(patched.entity.content.elements.length, 3);
  // null MERGED: the debounced editor sends elements alone and must not wipe
  // the title or the appState it did not restate.
  assert.equal(patched.entity.content.title, 'Auth sketch');
  assert.equal(patched.entity.content.app_state.viewBackgroundColor, '#ffffff');

  // D4, single-writer: the second editor loses, and loses WITHOUT clobbering.
  denied(
    'a stale expectedVersion must refuse, never clobber',
    `select public.update_drawing_entity(${uuid(state.drawing.id)}, 1, null,
       'Clobbered', null, '[]'::jsonb, null, null, ${literal(cmid('drawing-stale'))})`,
    { claims: w.claimsA },
  );
  const reread = commandEntity(state.drawing.id);
  assert.equal(reread.content.title, 'Auth sketch', 'the refused patch must not land');
  assert.equal(reread.content.elements.length, 3, 'the refused patch must not empty the canvas');
});

test('step 3 — a save snapshots the WHOLE canvas, so a drawing has history as a unit', () => {
  // `drawings_w2_snapshot_version` stores the entire row, which is what makes
  // a revision list possible later without a per-element history.
  //
  // NOT a count assertion: `snapshot_entity_version` COALESCES consecutive
  // edits by the same actor inside its window, so a debounced editor saving
  // five times in a minute leaves ONE row on purpose. Asserting ">= 2 rows"
  // passes or fails on that timing, not on the behaviour we care about — what
  // matters is that a snapshot exists and carries the canvas itself.
  const snapshot = json(
    `select snapshot from public.entity_versions
      where entity_id = ${uuid(state.drawing.id)}
      order by version desc limit 1`,
    { url: OWNER_URL },
  );
  assert.equal(snapshot.entity.kind, 'drawing');
  assert.equal(snapshot.content.title, 'Auth sketch');
  assert.equal(snapshot.content.elements.length, 3, 'the snapshot must hold the whole canvas');
});

test('step 4 — phase 1 refuses embedded images BY NAME (D3)', () => {
  // An Excalidraw paste puts base64 in `files`. Allowing it today would write
  // tens of megabytes into a row with no image lifecycle behind it. The
  // refusal is explicit so the editor can warn before work is lost; phase 2
  // relaxes exactly this check after splitting images to public.files.
  denied(
    'a non-empty files map must refuse on create',
    `select public.create_drawing_entity(${uuid(w.spaceA)}, 'With image', null,
       'excalidraw', '[]'::jsonb, '{}'::jsonb,
       '{"fileA":{"mimeType":"image/png","dataURL":"data:image/png;base64,iVBOR"}}'::jsonb,
       null, null, ${literal(cmid('drawing-img-create'))})`,
    { claims: w.claimsA, expect: '22023' },
  );
  denied(
    'a non-empty files map must refuse on patch',
    `select public.update_drawing_entity(${uuid(state.drawing.id)}, 2, null,
       null, null, null, null,
       '{"fileA":{"mimeType":"image/png","dataURL":"data:image/png;base64,iVBOR"}}'::jsonb,
       ${literal(cmid('drawing-img-patch'))})`,
    { claims: w.claimsA, expect: '22023' },
  );
});

test('step 5 — the doors refuse malformed input by name', () => {
  denied(
    'format must be a lowercase slug',
    `select public.create_drawing_entity(${uuid(w.spaceA)}, 'Bad format', null,
       'Not A Slug', '[]'::jsonb, '{}'::jsonb, '{}'::jsonb, null, null,
       ${literal(cmid('drawing-badformat'))})`,
    { claims: w.claimsA, expect: '22023' },
  );
  denied(
    'elements must be a JSON array',
    `select public.create_drawing_entity(${uuid(w.spaceA)}, 'Bad elements', null,
       'excalidraw', '{"not":"an array"}'::jsonb, '{}'::jsonb, '{}'::jsonb, null, null,
       ${literal(cmid('drawing-badelements'))})`,
    { claims: w.claimsA, expect: '22023' },
  );
  denied(
    'appState must be a JSON object',
    `select public.create_drawing_entity(${uuid(w.spaceA)}, 'Bad appState', null,
       'excalidraw', '[]'::jsonb, '["nope"]'::jsonb, '{}'::jsonb, null, null,
       ${literal(cmid('drawing-badappstate'))})`,
    { claims: w.claimsA, expect: '22023' },
  );
  denied(
    'title is required',
    `select public.create_drawing_entity(${uuid(w.spaceA)}, '  ', null,
       'excalidraw', '[]'::jsonb, '{}'::jsonb, '{}'::jsonb, null, null,
       ${literal(cmid('drawing-notitle'))})`,
    { claims: w.claimsA, expect: '22023' },
  );
});

test('step 6 — a drawing attaches to a task by EDGE, and a cross-kind PARENT is refused', () => {
  // Subhang's ruling: "while creating task, user should be able to create a
  // drawing and attach to task".
  //
  // The obvious reading — make the task the drawing's parent — IS REFUSED BY
  // THE DATABASE, and this test is what found that. `validate_entity_parent`
  // requires parent.kind = child.kind, with exactly one ruled exception
  // (chat -> work_session). `parent_id` means homogeneous hierarchy here
  // (a subtask under a task), never attachment.
  //
  // Attachment is an `attached_to` EDGE, which is what the server's
  // `attachInitialConnections` already writes for every kind but task/doc
  // when `entities.create` carries `attachTo` — so a drawing gets this for
  // free through the ordinary envelope, with no door change.
  const task = json(
    `select public.create_task(p_space_id => ${uuid(w.spaceA)},
       p_title => 'Design the login screen',
       p_client_mutation_id => ${literal(cmid('drawing-task'))})`,
    { claims: w.claimsA },
  ).entity;

  denied(
    'a task cannot be a drawing\'s parent — attachment is not hierarchy',
    `select public.create_drawing_entity(${uuid(w.spaceA)}, 'Wrong door', null,
       'excalidraw', '[]'::jsonb, '{}'::jsonb, '{}'::jsonb,
       ${uuid(task.id)}, null, ${literal(cmid('drawing-badparent'))})`,
    { claims: w.claimsA, expect: '23514' },
  );

  const drawing = json(
    `select public.create_drawing_entity(${uuid(w.spaceA)}, 'Login wireframe', null,
       'excalidraw', '[]'::jsonb, '{}'::jsonb, '{}'::jsonb, null, null,
       ${literal(cmid('drawing-attached'))})`,
    { claims: w.claimsA },
  ).entity;

  json(
    `select public.write_edge(${uuid(drawing.id)}, ${uuid(task.id)}, 'attached_to',
       '{}'::jsonb, null, ${literal(cmid('drawing-attach-edge'))})`,
    { claims: w.claimsA },
  );

  assert.equal(
    scalar(
      `select count(*) from public.edges
        where src_id = ${uuid(drawing.id)} and dst_id = ${uuid(task.id)}
          and type = 'attached_to'`,
      { url: OWNER_URL },
    ),
    '1',
    'the drawing must hang off the task by an attached_to edge',
  );
});

test('step 7 — a non-member cannot create or patch a drawing in the space', () => {
  denied(
    'outsider create must refuse',
    `select public.create_drawing_entity(${uuid(w.spaceA)}, 'Intruder', null,
       'excalidraw', '[]'::jsonb, '{}'::jsonb, '{}'::jsonb, null, null,
       ${literal(cmid('drawing-outsider'))})`,
    { claims: w.claimsB },
  );
  denied(
    'outsider patch must refuse',
    `select public.update_drawing_entity(${uuid(state.drawing.id)}, 2, null,
       'Stolen', null, null, null, null, ${literal(cmid('drawing-outpatch'))})`,
    { claims: w.claimsB },
  );
  // RLS on the detail table itself, not just the doors.
  assert.equal(
    scalar(`select count(*) from public.drawings where entity_id = ${uuid(state.drawing.id)}`,
      { claims: w.claimsB }),
    '0',
    'a non-member must not read the detail row',
  );
});
