// =============================================================================
// 055 artifacts — DB-level proof, run as tm8_app through the real RPCs.
//
// Follows the voice-channels.mjs precedent: not "the migration parsed" but the
// behaviors that fail silently when half-built. The two that matter most:
//
//  * V4 (docs/plans/TM8-FOUNDATION-VERIFICATION.md): the append-only trigger on
//    artifact_bundle_revisions carries a purge exemption (WHEN pg_trigger_depth()
//    = 0 on the DELETE trigger). The RED/GREEN PAIR the verification demanded is
//    steps 10-11 below: direct UPDATE and DELETE refused with 42501, AND the
//    entity purge cascade succeeds through the same trigger.
//
//  * §5.3 non-debounced publish: two same-actor publishes inside the 5-minute
//    snapshot debounce window must yield TWO new entity_versions rows (the
//    exact inverse of the debounce test in packages/server/test/w3/g02).
//
//  * Hole 1 (design §A.1): internal.entity_content must hydrate the artifact
//    detail, not fall through to '{}' — the ONLY way to tell a landed arm from
//    a silently-dropped one (three later migrations re-declare this function).
//
//   TM8_DATABASE_URL=postgres://tm8@127.0.0.1:5442/tm8_artifacts_verify \
//     node db/test/artifacts.mjs
// =============================================================================
import { randomUUID } from 'node:crypto';
import {
  json, run, scalar, claimsFor, buildWorld, literal, uuid, expectFailure, OWNER_URL, rows,
} from './helpers.mjs';

const tag = `art${Date.now().toString(36)}`;
const world = buildWorld(tag);
const spaceId = world.spaceA;
const { identityA, identityB, memberA } = world;
/** `internal.*` is not granted to tm8_app, so hydration/purge probes run as owner. */
const ownerOpts = { url: OWNER_URL };
const claimsA = claimsFor(identityA, memberA);

let failures = 0;
function check(label, actual, expected) {
  const pass = JSON.stringify(actual) === JSON.stringify(expected);
  if (!pass) failures += 1;
  console.log(
    `${pass ? 'PASS' : 'FAIL'}  ${label}` +
    (pass ? '' : `\n        expected ${JSON.stringify(expected)}\n        actual   ${JSON.stringify(actual)}`),
  );
}

const hex64 = (seed) => seed.repeat(64).slice(0, 64);
const HTML_SHA = hex64('a');
const JS_SHA = hex64('b');
const MANIFEST_SHA = hex64('c');
const TOKEN_HASH = hex64('d');
const storagePath = () => `spaces/${spaceId}/${randomUUID()}`;

// --- 1. the blob seam: register, dedupe, refuse corruption -------------------
const blob1 = json(
  `select public.register_stored_blob(${uuid(spaceId)}, ${literal(HTML_SHA)}, 120, ${literal(storagePath())}, ${uuid(memberA)})`,
  { claims: claimsA },
);
check('register_stored_blob inserts', blob1.inserted, true);

const blob1again = json(
  `select public.register_stored_blob(${uuid(spaceId)}, ${literal(HTML_SHA)}, 120, ${literal(storagePath())}, ${uuid(memberA)})`,
  { claims: claimsA },
);
check('re-registering the same (space, sha256) dedupes to the canonical row', blob1again.inserted, false);
check('…returning the CANONICAL storage path, not the duplicate upload', blob1again.storagePath, blob1.storagePath);

const corrupt = expectFailure(
  `select public.register_stored_blob(${uuid(spaceId)}, ${literal(HTML_SHA)}, 999, ${literal(storagePath())}, ${uuid(memberA)})`,
  { claims: claimsA },
);
check('same hash + different size is refused (23514), never smoothed over', corrupt.sqlstate, '23514');

json(
  `select public.register_stored_blob(${uuid(spaceId)}, ${literal(JS_SHA)}, 300, ${literal(storagePath())}, ${uuid(memberA)})`,
  { claims: claimsA },
);

// --- 2. create: entity + first revision, atomically --------------------------
const manifest = JSON.stringify({
  schema: 'tm8.web-artifact/1',
  runtime: 'web-static-v1',
  entrypoint: 'index.html',
  files: [
    { path: 'app.js', mediaType: 'text/javascript', size: 300, sha256: JS_SHA },
    { path: 'index.html', mediaType: 'text/html', size: 120, sha256: HTML_SHA },
  ],
});
const entries = JSON.stringify([
  { path: 'app.js', mediaType: 'text/javascript', sizeBytes: 300, sha256: JS_SHA },
  { path: 'index.html', mediaType: 'text/html', sizeBytes: 120, sha256: HTML_SHA },
]);
const createSql = (cmidSuffix) =>
  `select public.create_artifact(${uuid(spaceId)}, 'Dashboard', 'a demo bundle', ` +
  `${literal(manifest)}::jsonb, ${literal(MANIFEST_SHA)}, 'index.html', ` +
  `${literal(entries)}::jsonb, '{"schemaVersion":1}'::jsonb, null, ${uuid(memberA)}, null, null, ${literal(`${tag}-${cmidSuffix}`)})`;

const created = json(createSql('c1'), { claims: claimsA });
const artifactId = created.entity.id;
check('create_artifact returns an entity id', typeof artifactId === 'string' && artifactId.length > 0, true);
check('envelope kind is artifact',
  scalar(`select kind from public.entities where id = ${uuid(artifactId)}`, { claims: claimsA }),
  'artifact');
check('revision 1 exists with the right totals',
  json(`select jsonb_build_object('n', revision_number, 'files', file_count, 'bytes', total_size_bytes)
          from public.artifact_bundle_revisions where artifact_entity_id = ${uuid(artifactId)}`, { claims: claimsA }),
  { n: 1, bytes: 420, files: 2 });
check('entries are exact-path rows in manifest order',
  rows(`select path, ordinal from public.artifact_bundle_entries e
          join public.artifact_bundle_revisions r on r.id = e.revision_id
         where r.artifact_entity_id = ${uuid(artifactId)} order by ordinal`, { claims: claimsA }),
  [{ path: 'app.js', ordinal: 0 }, { path: 'index.html', ordinal: 1 }]);

// --- 3. idempotent replay ----------------------------------------------------
const replay = json(createSql('c1'), { claims: claimsA });
check('replaying the mutation id returns the same artifact', replay.entity.id, artifactId);

// --- 4. Hole 1: entity_content hydrates, not '{}' ----------------------------
const content = json(`select internal.entity_content(${uuid(artifactId)})`, ownerOpts);
check('entity_content hydrates the artifact detail (name)', content.name, 'Dashboard');
check('entity_content does not leak entity_id', 'entity_id' in content, false);

// --- 5. publish is non-debounced: 3 versions after create + 2 rapid publishes -
const publishSql = (expectVersion, cmidSuffix) =>
  `select public.publish_artifact_revision(${uuid(artifactId)}, ${expectVersion}, ` +
  `${literal(manifest)}::jsonb, ${literal(MANIFEST_SHA)}, 'index.html', ` +
  `${literal(entries)}::jsonb, '{"schemaVersion":1}'::jsonb, null, ${uuid(memberA)}, ${literal(`${tag}-${cmidSuffix}`)})`;

json(publishSql(1, 'p1'), { claims: claimsA });
json(publishSql(2, 'p2'), { claims: claimsA });
check('two same-actor publishes inside the debounce window append TWO snapshot rows (V-§5.3)',
  json(`select jsonb_agg(version order by version)
          from public.entity_versions where entity_id = ${uuid(artifactId)}`, ownerOpts),
  [1, 2, 3]);
check('current revision advanced to 3',
  json(`select jsonb_build_object('n', r.revision_number)
          from public.artifacts a join public.artifact_bundle_revisions r on r.id = a.current_revision_id
         where a.entity_id = ${uuid(artifactId)}`, { claims: claimsA }),
  { n: 3 });
check('identical manifest bytes republished is LEGAL (provenance differs, content does not)',
  scalar(`select count(distinct manifest_sha256) from public.artifact_bundle_revisions
           where artifact_entity_id = ${uuid(artifactId)}`, { claims: claimsA }),
  '1');

// --- 6. optimistic concurrency ----------------------------------------------
const stale = expectFailure(publishSql(1, 'p3'), { claims: claimsA });
check('publish with a stale expectedVersion is a version conflict (40001)', stale.sqlstate, '40001');

// --- 7. bundle coherence refusals (22023 invalid_input family) ---------------
const unknownBlob = expectFailure(
  `select public.create_artifact(${uuid(spaceId)}, 'Broken', null, ${literal(manifest)}::jsonb, ${literal(MANIFEST_SHA)}, 'index.html', ` +
  `'[{"path":"index.html","mediaType":"text/html","sizeBytes":120,"sha256":"${hex64('e')}"}]'::jsonb, '{"schemaVersion":1}'::jsonb, null, ${uuid(memberA)}, null, null, ${literal(`${tag}-c2`)})`,
  { claims: claimsA },
);
check('a manifest referencing an unregistered blob is refused (22023)', unknownBlob.sqlstate, '22023');

const sizeLie = expectFailure(
  `select public.create_artifact(${uuid(spaceId)}, 'Broken2', null, ${literal(manifest)}::jsonb, ${literal(MANIFEST_SHA)}, 'index.html', ` +
  `'[{"path":"index.html","mediaType":"text/html","sizeBytes":121,"sha256":"${HTML_SHA}"}]'::jsonb, '{"schemaVersion":1}'::jsonb, null, ${uuid(memberA)}, null, null, ${literal(`${tag}-c3`)})`,
  { claims: claimsA },
);
check('a declared size disagreeing with the stored blob is refused (22023)', sizeLie.sqlstate, '22023');

const noEntry = expectFailure(
  `select public.create_artifact(${uuid(spaceId)}, 'Broken3', null, ${literal(manifest)}::jsonb, ${literal(MANIFEST_SHA)}, 'missing.html', ` +
  `${literal(entries)}::jsonb, '{"schemaVersion":1}'::jsonb, null, ${uuid(memberA)}, null, null, ${literal(`${tag}-c4`)})`,
  { claims: claimsA },
);
check('an entrypoint outside the bundle is refused (22023)', noEntry.sqlstate, '22023');

const tooMany = expectFailure(
  `select public.create_artifact(${uuid(spaceId)}, 'Broken4', null, ${literal(manifest)}::jsonb, ${literal(MANIFEST_SHA)}, 'index.html', ` +
  `(select jsonb_agg(jsonb_build_object('path', 'f' || i, 'mediaType', 'text/plain', 'sizeBytes', 1, 'sha256', '${HTML_SHA}')) from generate_series(1,129) i), ` +
  `'{"schemaVersion":1}'::jsonb, null, ${uuid(memberA)}, null, null, ${literal(`${tag}-c5`)})`,
  { claims: claimsA },
);
check('129 files is refused (22023)', tooMany.sqlstate, '22023');

// --- 8. RLS: a non-member sees nothing and writes nothing --------------------
check('non-member reads zero revision rows (RLS)',
  scalar(`select count(*) from public.artifact_bundle_revisions where artifact_entity_id = ${uuid(artifactId)}`,
    { claims: claimsFor(identityB) }),
  '0');
check('non-member reads zero blob rows (RLS)',
  scalar(`select count(*) from public.stored_blobs where space_id = ${uuid(spaceId)}`,
    { claims: claimsFor(identityB) }),
  '0');
const foreignPublish = run(publishSql(3, 'px'), { claims: claimsFor(identityB), verbose: true });
check('non-member publish is refused', foreignPublish.ok, false);

// --- 9. preview sessions: capability rows, revoked at the moment of delete ----
const preview = json(
  `select public.start_artifact_preview(${uuid(artifactId)}, null, ${literal(TOKEN_HASH)}, ${literal(identityA)}, 600, ${uuid(memberA)}, ${literal(`${tag}-pv1`)})`,
  { claims: claimsA },
);
check('preview session minted against the current revision', preview.revisionNumber, 3);
check('the session stores only the token HASH',
  scalar(`select token_hash from public.artifact_preview_sessions where id = ${uuid(preview.previewSessionId)}`, { claims: claimsA }),
  TOKEN_HASH);

json(`select public.delete_entity(${uuid(artifactId)}, ${uuid(memberA)}, ${literal(`${tag}-del1`)})`, { claims: claimsA });
check('soft delete revokes live preview sessions in the same transaction',
  scalar(`select count(*) from public.artifact_preview_sessions
           where artifact_entity_id = ${uuid(artifactId)} and revoked_at is null`, ownerOpts),
  '0');
const previewAfterDelete = run(
  `select public.start_artifact_preview(${uuid(artifactId)}, null, ${literal(hex64('f'))}, ${literal(identityA)}, 600, ${uuid(memberA)}, ${literal(`${tag}-pv2`)})`,
  { claims: claimsA, verbose: true },
);
check('no new preview on a soft-deleted artifact', previewAfterDelete.ok, false);

// --- 10. V4 RED: direct mutation of a revision row is refused, even as owner --
const directUpdate = expectFailure(
  `update public.artifact_bundle_revisions set entrypoint_path = 'x' where artifact_entity_id = ${uuid(artifactId)}`,
  ownerOpts,
);
check('direct UPDATE on a revision row raises 42501 (append-only)', directUpdate.sqlstate, '42501');
const directDelete = expectFailure(
  `delete from public.artifact_bundle_revisions where artifact_entity_id = ${uuid(artifactId)}`,
  ownerOpts,
);
check('direct DELETE on a revision row raises 42501 (append-only)', directDelete.sqlstate, '42501');

// --- 11. V4 GREEN: the entity purge cascade passes THROUGH the same trigger ---
const purge = run(`delete from public.entities where id = ${uuid(artifactId)}`, ownerOpts);
check('entity purge succeeds through the append-only trigger (the V4 exemption)', purge.ok, true);
check('…and the cascade removed revisions, entries and preview sessions',
  scalar(
    `select (select count(*) from public.artifact_bundle_revisions where artifact_entity_id = ${uuid(artifactId)})
          + (select count(*) from public.artifact_bundle_entries e join public.artifact_bundle_revisions r on r.id = e.revision_id
              where r.artifact_entity_id = ${uuid(artifactId)})
          + (select count(*) from public.artifact_preview_sessions where artifact_entity_id = ${uuid(artifactId)})
          + (select count(*) from public.artifacts where entity_id = ${uuid(artifactId)})`,
    ownerOpts),
  '0');
check('…while blobs survive (GC is the only blob deletion authority, design §10.4)',
  scalar(`select count(*) from public.stored_blobs where space_id = ${uuid(spaceId)}`, ownerOpts),
  '2');

// --- 12. purge WITH a provenance edge — the guard_w1_edge cascade hazard ------
// (Surfaced by the memories lane, 2026-07-31.) guard_w1_edge refuses DELETE of
// recorder-owned edge types unless writer = 'forward_compensation' — and a
// cascade delete carries NO writer claim. So hard-purging an entity that has an
// authored_from edge fails 42501 TODAY unless the purge transaction claims
// forward_compensation first. Both halves pinned here so the future retention
// sweep is written against measured behavior, not assumption.
const ws2 = scalar(`select internal.create_envelope(${uuid(spaceId)}, 'work_session', ${uuid(memberA)}, null, null)`, ownerOpts);
run(`insert into public.work_sessions(entity_id) values (${uuid(ws2)})`, ownerOpts);
const art2 = json(
  `select public.create_artifact(${uuid(spaceId)}, 'WithProvenance', null, ${literal(manifest)}::jsonb, ${literal(MANIFEST_SHA)}, 'index.html', ` +
  `${literal(entries)}::jsonb, '{"schemaVersion":1}'::jsonb, ${uuid(ws2)}, ${uuid(memberA)}, null, null, ${literal(`${tag}-c6`)})`,
  { claims: claimsA },
).entity.id;
check('authored_from provenance edge exists (writer artifact_publisher accepted)',
  scalar(`select count(*) from public.edges where src_id = ${uuid(art2)} and type = 'authored_from'`, ownerOpts),
  '1');
const purgeWithEdge = expectFailure(`delete from public.entities where id = ${uuid(art2)}`, ownerOpts);
check('purge of an artifact WITH provenance is refused by guard_w1_edge (42501) — pre-existing cascade gap, hits every recorder-owned kind',
  purgeWithEdge.sqlstate, '42501');
const purgeClaimed = run(`delete from public.entities where id = ${uuid(art2)}`,
  { url: OWNER_URL, claims: { 'tm8.w1_writer': 'forward_compensation' } });
check('…and succeeds when the purge transaction claims forward_compensation', purgeClaimed.ok, true);
check('…removing the edge and all artifact rows with it',
  scalar(`select (select count(*) from public.edges where src_id = ${uuid(art2)})
              + (select count(*) from public.artifact_bundle_revisions where artifact_entity_id = ${uuid(art2)})`, ownerOpts),
  '0');

// --- 13. the kind is seeded core ---------------------------------------------
check('artifact is seeded in entity_kinds as a core kind',
  scalar(`select origin from public.entity_kinds where kind = 'artifact'`, { claims: claimsA }),
  'core');

console.log(`\n${failures === 0 ? 'ALL PASS' : `${failures} FAILURE(S)`} — db/test/artifacts.mjs (${new Date().toISOString()})`);
process.exit(failures === 0 ? 0 : 1);
