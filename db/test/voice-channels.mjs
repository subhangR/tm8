// =============================================================================
// 053 voice channels — DB-level proof, run as tm8_app through the real RPCs.
//
// This is deliberately NOT "the migration parsed". Applying SQL proves syntax;
// what matters is that a low-privilege caller can create a voice channel, that
// the envelope trigger rejects a mistyped detail row, that content hydration
// returns the row (the `create or replace internal.entity_content` arm), and
// that a non-member is refused. Each of those is a separate way the feature
// could be silently half-built.
//
// It has already earned its keep: the first draft of 053 omitted
// `set role tm8_graph_owner`, and EVERY static check passed anyway — migration
// applied clean, table present, RLS on, policy present, has_table_privilege
// for tm8_app true. Only step 1 below (an actual create) failed, because
// internal.command_entity is SECURITY DEFINER owned by tm8_graph_owner and
// reads the detail table as THAT role on the command-result hop.
//
//   TM8_DATABASE_URL=postgres://tm8@127.0.0.1:5442/tm8_voice_scratch \
//     node db/test/voice-channels.mjs
// =============================================================================
import { readFileSync } from 'node:fs';

import {
  json, run, scalar, claimsFor, buildWorld, literal, uuid, expectFailure, OWNER_URL,
} from './helpers.mjs';

const tag = `voice${Date.now().toString(36)}`;
const world = buildWorld(tag);
const spaceId = world.spaceA;
const { identityA, identityB, memberA } = world;
/** `internal.*` is not granted to tm8_app, so the hydration probes run as owner. */
const ownerOpts = { url: OWNER_URL };

let failures = 0;
function check(label, actual, expected) {
  const pass = JSON.stringify(actual) === JSON.stringify(expected);
  if (!pass) failures += 1;
  console.log(
    `${pass ? 'PASS' : 'FAIL'}  ${label}` +
    (pass ? '' : `\n        expected ${JSON.stringify(expected)}\n        actual   ${JSON.stringify(actual)}`),
  );
}

const createSql = (name, cmid, actor = uuid(memberA)) =>
  `select public.create_voice_channel(${uuid(spaceId)}, ${literal(name)}, ${actor}, null, null, ${literal(cmid)})`;

// --- 1. create through the RPC, as tm8_app -----------------------------------
const created = json(createSql('general-voice', `${tag}-m1`), { claims: claimsFor(identityA, memberA) });
const voiceId = created.entity.id;
check('create_voice_channel returns an entity id', typeof voiceId === 'string' && voiceId.length > 0, true);

// --- 2. the envelope really is of the new kind -------------------------------
check(
  'envelope kind is voice_channel',
  scalar(`select kind from public.entities where id = ${uuid(voiceId)}`, { claims: claimsFor(identityA, memberA) }),
  'voice_channel',
);

// --- 3. content hydration — the entity_content arm this migration added.
//        A missing arm returns '{}' rather than raising, so this is the ONLY
//        way to tell a landed arm from a silently-dropped one.
const content = json(`select internal.entity_content(${uuid(voiceId)})`, ownerOpts);
check('entity_content hydrates the detail row (name)', content.name, 'general-voice');
check('entity_content does not leak entity_id', 'entity_id' in content, false);

// --- 4. name normalisation (lower+btrim), same grammar as channels ------------
const mixed = json(createSql('  LOUNGE  ', `${tag}-m2`), { claims: claimsFor(identityA, memberA) });
check(
  'name is lowercased and trimmed',
  scalar(`select name from public.voice_channels where entity_id = ${uuid(mixed.entity.id)}`,
    { claims: claimsFor(identityA, memberA) }),
  'lounge',
);

// --- 5. the envelope trigger: a detail row on a non-voice entity must raise ---
const wrongKind = expectFailure(
  `insert into public.voice_channels(entity_id, space_id, name) values (${uuid(world.taskA)}, ${uuid(spaceId)}, 'bogus')`,
  ownerOpts,
);
check('detail row on a task entity raises 23514', wrongKind.sqlstate, '23514');
check('…and says which kind it wanted',
  /requires an entity of kind voice_channel/.test(wrongKind.stderr), true);

// --- 6. a non-member cannot create one ---------------------------------------
const outsider = run(createSql('intruder', `${tag}-m3`, 'null'), { claims: claimsFor(identityB), verbose: true });
check('non-member create is refused', outsider.ok, false);

// --- 7. a non-member cannot read the detail row either (RLS) -----------------
check(
  'non-member reads zero rows (RLS)',
  scalar(`select count(*) from public.voice_channels where entity_id = ${uuid(voiceId)}`,
    { claims: claimsFor(identityB) }),
  '0',
);

// --- 8. idempotency: replaying the same mutation id returns the same entity ---
const replay = json(createSql('general-voice', `${tag}-m1`), { claims: claimsFor(identityA, memberA) });
check('replaying the mutation id returns the same id, not a second channel', replay.entity.id, voiceId);

// --- 9. unique (space_id, name) ----------------------------------------------
const dup = run(createSql('general-voice', `${tag}-m4`), { claims: claimsFor(identityA, memberA), verbose: true });
check('a second channel with the same name is refused', dup.ok, false);

// --- 10. the kind is registered, so the UI kind registry can find it ---------
check('voice_channel is seeded in entity_kinds as a core kind',
  scalar(`select origin from public.entity_kinds where kind = 'voice_channel'`,
    { claims: claimsFor(identityA, memberA) }),
  'core');

// --- 11. TOKEN AUTHORIZATION -------------------------------------------------
//
// `voice.token.create` has no hand-written permission check: it selects the
// target row through the CALLER'S claims under `set local role tm8_app`, and a
// returned row IS the authorization. So the thing to test is that query, and
// the query is READ OUT OF THE SERVICE SOURCE rather than copied here — a
// second copy would keep passing after the real one changed, which is the
// failure mode this whole file exists to avoid.
const serviceSrc = readFileSync(
  new URL('../../packages/server/src/facade/services/voice.ts', import.meta.url), 'utf8',
);
const extracted = /const RESOLVE_SQL = `([\s\S]*?)`;/.exec(serviceSrc)?.[1];
check('the token service SQL could be read out of the service (parser not silently broken)',
  typeof extracted === 'string' && extracted.includes('public.voice_channels'), true);

if (typeof extracted === 'string') {
  const bound = extracted.replace('$1', uuid(voiceId));
  const asMember = run(`set local role tm8_app; ${bound}`,
    { claims: claimsFor(identityA, memberA), singleTransaction: true, verbose: true });
  const asOutsider = run(`set local role tm8_app; ${bound}`,
    { claims: claimsFor(identityB, world.memberB), singleTransaction: true, verbose: true });

  check('a space member resolves the row, so a token is minted', asMember.stdout.includes(voiceId), true);
  check('…and it carries their member id, which becomes the LiveKit identity',
    asMember.stdout.includes(memberA), true);
  check('A NON-MEMBER RESOLVES NOTHING, so no token can be minted',
    asOutsider.stdout.includes(voiceId), false);
}

console.log(`\n${failures === 0 ? 'ALL PASS' : `${failures} FAILURE(S)`} — db/test/voice-channels.mjs (${new Date().toISOString()})`);
process.exit(failures === 0 ? 0 : 1);
