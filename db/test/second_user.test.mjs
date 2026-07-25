// =============================================================================
// Two users racing each other on the SAME row.
//
// The other suites cover a second user's PERMISSIONS (rls_negatives) and a retry of
// one user's own mutation (ledger_replay). This one covers the third case: two
// legitimate members, both entitled, both acting on the same entity at the same
// instant. Every assertion is "exactly one won, the loser was refused, and the
// side effect happened once" — because the failure mode here is never an error, it
// is a double effect that nobody notices.
//
// The three races that matter on the loop: editing a task, completing a task
// (it pays points), and redeeming a single-use invite (it grants membership).
// =============================================================================

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildWorld,
  claimsFor,
  cmid,
  json,
  literal,
  ok,
  rootClaims,
  runAsync,
  scalar,
  uuid,
} from './helpers.mjs';

const w = buildWorld('race');

// A second real member of space A, so both racers are entitled.
const identityC = 'identity-race-c';
json(`select public.ensure_account(${literal(identityC)}, 'race-c', 'Racer C', null, false, false)`, {
  claims: rootClaims(),
});
const seatInvite = json(`select public.create_invite(${uuid(w.spaceA)}, 10)`, { claims: w.claimsA })
  .invite;
const memberC = json(`select public.redeem_invite(${literal(seatInvite.code)})`, {
  claims: claimsFor(identityC),
}).memberId;
const claimsC = claimsFor(identityC, memberC);

/** Split a settled pair of concurrent results into winners and losers. */
function settle(results, label) {
  const winners = results.filter((r) => r.ok);
  const losers = results.filter((r) => !r.ok);
  assert.equal(
    winners.length,
    1,
    `${label}\n  EXPECTED: exactly 1 of the ${results.length} concurrent callers to succeed\n` +
      `  ACTUAL:   ${winners.length} succeeded, ${losers.length} were refused\n` +
      losers.map((l, i) => `  loser ${i} sqlstate=${l.sqlstate}: ${l.stderr.split('\n')[0]}`).join('\n'),
  );
  return { winner: winners[0], losers };
}

test('two members editing one task at the same version: one wins, the other gets 40001', async () => {
  const task = json(`select public.create_task(${uuid(w.spaceA)}, 'contested')`, { claims: w.claimsA })
    .entity;

  // Both racers were handed version 1 by their last read, which is exactly what
  // optimistic concurrency is for.
  const results = await Promise.all([
    runAsync(
      `select public.update_task_content(${uuid(task.id)}, 1, null, 'renamed by A', null, null, null,
         null, null, null, null, false, ${literal(cmid('race-edit-a'))})`,
      { claims: w.claimsA, verbose: true },
    ),
    runAsync(
      `select public.update_task_content(${uuid(task.id)}, 1, null, 'renamed by C', null, null, null,
         null, null, null, null, false, ${literal(cmid('race-edit-c'))})`,
      { claims: claimsC, verbose: true },
    ),
  ]);

  const { losers } = settle(results, 'concurrent update_task_content at the same expected version');
  assert.equal(
    losers[0].sqlstate,
    '40001',
    'the loser must get a version conflict, not a silent last-write-wins',
  );

  // The surviving title is one of the two, never a blend, and the version advanced
  // exactly once.
  const after = json(
    `select jsonb_build_object('title', t.title, 'version', e.version)
       from public.tasks t join public.entities e on e.id = t.entity_id
      where t.entity_id = ${uuid(task.id)}`,
    { claims: w.claimsA },
  );
  assert.ok(
    ['renamed by A', 'renamed by C'].includes(after.title),
    `the task title must be one racer's value, got ${JSON.stringify(after.title)}`,
  );
  assert.equal(after.version, 2, 'exactly one edit may have advanced the version');
});

test('two members completing one task at once: it pays out ONCE', async () => {
  // The expensive race: complete_task writes points. A double completion that
  // paid twice would be invisible until someone audited the ledger.
  const task = json(
    `select public.create_task(${uuid(w.spaceA)}, 'double payout probe', null, '', '{}'::jsonb, null,
       null, 'medium', '[{"text":"ready","done":true}]'::jsonb, 11)`,
    { claims: w.claimsA },
  ).entity;

  const results = await Promise.all([
    runAsync(
      `select public.complete_task(${uuid(task.id)}, ${task.version},
         array[${uuid(w.memberA)}]::uuid[], null, ${literal(cmid('race-done-a'))})`,
      { claims: w.claimsA, verbose: true },
    ),
    runAsync(
      `select public.complete_task(${uuid(task.id)}, ${task.version},
         array[${uuid(w.memberA)}]::uuid[], null, ${literal(cmid('race-done-c'))})`,
      { claims: claimsC, verbose: true },
    ),
  ]);

  const { losers } = settle(results, 'concurrent complete_task on one task');
  // Either refusal is correct: the FOR UPDATE on the entity serialises the pair, so
  // the loser trips whichever guard it reaches first — the stale version it is now
  // holding (40001) or the already-done check (23514).
  assert.ok(
    ['40001', '23514'].includes(losers[0].sqlstate),
    `the loser must be refused by the version check (40001) or the already-complete ` +
      `check (23514); got ${losers[0].sqlstate}`,
  );

  assert.equal(
    scalar(
      `select count(*) from public.point_events
        where ref_id = ${uuid(task.id)} and entity_id = ${uuid(w.memberA)} and reason = 'award'`,
      { claims: w.claimsA },
    ),
    '1',
    'THE POINT OF THIS TEST: two simultaneous completions must pay exactly one award',
  );
  assert.equal(
    scalar(`select sum(amount) from public.point_events where ref_id = ${uuid(task.id)}`, {
      claims: w.claimsA,
    }),
    '11',
    'the payout total must be the estimate, not a multiple of it',
  );
  assert.equal(
    scalar(
      `select count(*) from public.edges
        where src_id = ${uuid(task.id)} and dst_id = ${uuid(w.memberA)} and type = 'completed_by'`,
      { claims: w.claimsA },
    ),
    '1',
    'and exactly one completed_by edge',
  );
});

test('two identities redeeming one single-use invite: max_uses is a limit, not a hint', async () => {
  for (const [id, username] of [
    ['identity-race-d', 'race-d'],
    ['identity-race-e', 'race-e'],
  ]) {
    json(`select public.ensure_account(${literal(id)}, ${literal(username)}, 'Racer', null, false, false)`, {
      claims: rootClaims(),
    });
  }
  const single = json(`select public.create_invite(${uuid(w.spaceA)}, 1)`, { claims: w.claimsA }).invite;
  const membersBefore = Number(
    scalar(`select count(*) from public.members where space_id = ${uuid(w.spaceA)}`, {
      claims: w.claimsA,
    }),
  );

  const results = await Promise.all([
    runAsync(`select public.redeem_invite(${literal(single.code)}, ${literal(cmid('race-redeem-d'))})`, {
      claims: claimsFor('identity-race-d'),
      verbose: true,
    }),
    runAsync(`select public.redeem_invite(${literal(single.code)}, ${literal(cmid('race-redeem-e'))})`, {
      claims: claimsFor('identity-race-e'),
      verbose: true,
    }),
  ]);

  const { losers } = settle(results, 'concurrent redeem_invite of a single-use code');
  assert.equal(
    losers[0].sqlstate,
    '53400',
    'the loser must be told the invite is exhausted (53400 -> limit_exceeded), not let in',
  );

  assert.equal(
    scalar(`select use_count from public.space_invites where id = ${uuid(single.id)}`, {
      claims: w.claimsA,
    }),
    '1',
    'use_count must not exceed max_uses — the FOR UPDATE on the invite row is what holds this',
  );
  assert.equal(
    Number(
      scalar(`select count(*) from public.members where space_id = ${uuid(w.spaceA)}`, {
        claims: w.claimsA,
      }),
    ),
    membersBefore + 1,
    'exactly one of the two racers may have joined the space',
  );
});

test('re-redeeming as a member already in the space is idempotent, not a second seat', () => {
  // The benign twin of the race above: a member who clicks an invite link again
  // must not consume a use or gain a second member row.
  const invite = json(`select public.create_invite(${uuid(w.spaceA)}, 5)`, { claims: w.claimsA }).invite;
  const before = scalar(`select use_count from public.space_invites where id = ${uuid(invite.id)}`, {
    claims: w.claimsA,
  });

  const again = json(`select public.redeem_invite(${literal(invite.code)})`, { claims: claimsC });
  assert.equal(again.memberId, memberC, 'an existing member must get its existing member id back');
  assert.equal(again.joined, false, 'and be told it did not newly join');
  assert.equal(
    scalar(`select use_count from public.space_invites where id = ${uuid(invite.id)}`, {
      claims: w.claimsA,
    }),
    before,
    'an already-member redemption must not consume a use',
  );
  assert.equal(
    scalar(
      `select count(*) from public.members
        where space_id = ${uuid(w.spaceA)} and identity_id = ${literal(identityC)}`,
      { claims: w.claimsA },
    ),
    '1',
  );
});

test('two members posting into one thread concurrently: both land, both ordered', async () => {
  // The loop's read side under two users. Nothing should be refused here — this is
  // the case that must NOT serialise into a conflict, only into an order.
  const task = json(`select public.create_task(${uuid(w.spaceA)}, 'busy thread')`, {
    claims: w.claimsA,
  }).entity;

  const results = await Promise.all([
    runAsync(
      `select public.post_message(${uuid(task.id)}, 'from A', null, null, '[]'::jsonb, '[]'::jsonb,
         ${literal(cmid('race-msg-a'))})`,
      { claims: w.claimsA, verbose: true },
    ),
    runAsync(
      `select public.post_message(${uuid(task.id)}, 'from C', null, null, '[]'::jsonb, '[]'::jsonb,
         ${literal(cmid('race-msg-c'))})`,
      { claims: claimsC, verbose: true },
    ),
  ]);
  results.forEach((r, i) => assert.ok(r.ok, `poster ${i} was refused:\n${r.stderr}`));

  assert.equal(
    scalar(`select count(*) from public.messages where anchor_id = ${uuid(task.id)}`, {
      claims: w.claimsA,
    }),
    '2',
    'both messages must land — concurrent posts are not a conflict',
  );
  assert.equal(
    scalar(`select messages from public.entity_counters where entity_id = ${uuid(task.id)}`, {
      claims: w.claimsA,
    }),
    '2',
    'and the derived counter must have counted both, not lost one to a race',
  );
});
