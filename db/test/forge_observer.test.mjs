// =============================================================================
// 084 — the forge observer's facts, its watch list, and its dedup.
//
// Every assertion here is about a DIFFERENCE, because that is the only thing
// this migration exists to compute. A door that stores check runs correctly and
// reports "newly failing" for a check that has been red for an hour has stored
// the right rows and answered the wrong question, and only a test that calls it
// TWICE can tell those apart. So the suite is written as sequences: observe,
// observe again, change something, observe again.
//
// The three loops' suppression rules are proven here too, at the level they are
// decided: `stackedOnOpenParent` and `owningSessionLive` come out of SQL, and a
// TypeScript test asserting on a hand-built object would prove nothing about
// the joins that actually produce them.
// =============================================================================

import test from 'node:test';
import assert from 'node:assert/strict';

import { OWNER_URL, buildWorld, json, literal, ok, scalar, uuid } from './helpers.mjs';

const w = buildWorld('forge');

const SHA_A = 'a'.repeat(40);
const SHA_B = 'b'.repeat(40);

/** Spawn a live session in space A. Returns the work_session entity id. */
function spawnSession(title) {
  const res = json(
    `select public.execution_spawn(${uuid(w.spaceA)}, ${uuid(w.personaA)}, array[${uuid(w.taskA)}]::uuid[],
       ${uuid(w.projectId)}, 'project', null, null, 'worker', null, null, ${literal(title)})`,
    { claims: w.claimsA },
  );
  return res.entity?.id ?? res.sessionId ?? res.entityId;
}

/** Link a PR to the suite's task and return its entity id. */
function linkPr(number, repo = 'acme/forge') {
  json(
    `select public.link_pull_request(${uuid(w.taskA)}, ${literal(`https://github.com/${repo}/pull/${number}`)},
       'github', ${literal(repo)}, ${number})`,
    { claims: w.claimsA },
  );
  return scalar(
    `select entity_id from public.pull_requests
      where space_id = ${uuid(w.spaceA)} and repo = ${literal(repo)} and number = ${number}`,
    { url: OWNER_URL },
  );
}

const checksJson = (checks) => `${literal(JSON.stringify(checks))}::jsonb`;

function applyChecks(prId, sha, checks) {
  return json(
    `select public.apply_pr_check_facts(${uuid(prId)}, ${literal(sha)}, ${checksJson(checks)})`,
    { claims: w.claimsA },
  );
}

function applyThreads(prId, threads) {
  return json(
    `select public.apply_pr_review_thread_facts(${uuid(prId)}, ${checksJson(threads)})`,
    { claims: w.claimsA },
  );
}

function watchTargets() {
  return json(`select public.observer_watch_targets(50, 0)`, { claims: w.claimsA }).targets;
}

function targetFor(prId) {
  return watchTargets().find((t) => t.prEntityId === prId) ?? null;
}

// -----------------------------------------------------------------------------

test('a check that goes red is newly failing exactly once', () => {
  const pr = linkPr(101);
  const red = [{ name: 'build', status: 'completed', conclusion: 'failure', externalId: '9001' }];

  const first = applyChecks(pr, SHA_A, red);
  assert.equal(first.newlyFailing.length, 1, 'first sight of a red check is news');
  assert.equal(first.newlyFailing[0].name, 'build');
  assert.equal(first.ciStatus, 'failing');

  // The SAME observation again. This is the assertion the whole diff exists
  // for: a watcher ticks every ninety seconds, and a door that reported this
  // again would nudge the agent about the same failure forty times an hour.
  const second = applyChecks(pr, SHA_A, red);
  assert.deepEqual(second.newlyFailing, [], 'a check that was already red is not news');
  assert.equal(second.ciStatus, 'failing');
});

test('green is not news, and going red AGAIN after green is', () => {
  const pr = linkPr(102);
  const green = [{ name: 'build', status: 'completed', conclusion: 'success' }];
  const red = [{ name: 'build', status: 'completed', conclusion: 'failure' }];

  assert.equal(applyChecks(pr, SHA_A, green).ciStatus, 'passing');
  assert.deepEqual(applyChecks(pr, SHA_A, green).newlyFailing, []);
  assert.equal(applyChecks(pr, SHA_A, red).newlyFailing.length, 1);
  assert.deepEqual(applyChecks(pr, SHA_A, red).newlyFailing, []);
  // Recovered, then broken again — a genuine second incident, reported again.
  assert.deepEqual(applyChecks(pr, SHA_A, green).newlyFailing, []);
  assert.equal(applyChecks(pr, SHA_A, red).newlyFailing.length, 1);
});

test('a pending check rolls up to pending, and an empty check set to unknown', () => {
  const pr = linkPr(103);
  assert.equal(
    applyChecks(pr, SHA_A, [{ name: 'build', status: 'in_progress', conclusion: null }]).ciStatus,
    'pending',
  );
  // NULL, not 'passing'. A repo with no CI on this commit has not passed
  // anything, and 082's completion gate treats NULL as unknown and green as a
  // reason to allow completion.
  assert.equal(applyChecks(pr, SHA_B, []).ciStatus, null);
});

test('neutral and skipped conclusions are NOT failures', () => {
  const pr = linkPr(104);
  const res = applyChecks(pr, SHA_A, [
    { name: 'optional-lint', status: 'completed', conclusion: 'skipped' },
    { name: 'advisory', status: 'completed', conclusion: 'neutral' },
  ]);
  assert.deepEqual(res.newlyFailing, [], 'a skipped optional check is not a CI failure');
  assert.equal(res.ciStatus, 'passing');
});

test('a new head sha discards the previous commit\u2019s checks', () => {
  const pr = linkPr(105);
  applyChecks(pr, SHA_A, [{ name: 'build', status: 'completed', conclusion: 'failure' }]);
  assert.equal(
    Number(scalar(`select count(*) from public.pr_check_facts where pr_entity_id = ${uuid(pr)}`, {
      url: OWNER_URL,
    })),
    1,
  );

  // The push that fixes it. The old sha's red row must not survive, or the
  // rollup would report the PR as failing forever.
  const after = applyChecks(pr, SHA_B, [{ name: 'build', status: 'completed', conclusion: 'success' }]);
  assert.equal(after.ciStatus, 'passing');
  assert.equal(
    Number(scalar(
      `select count(*) from public.pr_check_facts where pr_entity_id = ${uuid(pr)} and head_sha = ${literal(SHA_A)}`,
      { url: OWNER_URL },
    )),
    0,
    'checks for a sha the PR no longer points at are not facts about it',
  );
});

test('a check the provider stops reporting is forgotten', () => {
  const pr = linkPr(106);
  applyChecks(pr, SHA_A, [
    { name: 'build', status: 'completed', conclusion: 'success' },
    { name: 'removed-workflow', status: 'completed', conclusion: 'failure' },
  ]);
  const after = applyChecks(pr, SHA_A, [{ name: 'build', status: 'completed', conclusion: 'success' }]);
  assert.equal(after.total, 1);
  assert.equal(after.ciStatus, 'passing', 'a withdrawn red check must stop poisoning the rollup');
});

// -----------------------------------------------------------------------------

test('an unresolved review thread is newly unresolved once, and again when reopened', () => {
  const pr = linkPr(201);
  const open = [{
    threadKey: 'RT_open', path: 'src/a.ts', line: 12, isResolved: false,
    commentCount: 1, author: 'reviewer', bodyExcerpt: 'this leaks',
  }];

  const first = applyThreads(pr, open);
  assert.equal(first.newlyUnresolved.length, 1);
  assert.equal(first.newlyUnresolved[0].threadKey, 'RT_open');
  assert.equal(first.unresolvedCount, 1);

  assert.deepEqual(applyThreads(pr, open).newlyUnresolved, [], 'a thread already open is not news');

  const resolved = applyThreads(pr, [{ ...open[0], isResolved: true }]);
  assert.deepEqual(resolved.newlyUnresolved, []);
  assert.equal(resolved.unresolvedCount, 0);

  // Reopened by the reviewer. That IS news — the agent thought it was done.
  assert.equal(applyThreads(pr, open).newlyUnresolved.length, 1);
});

test('an OUTDATED thread is still unresolved', () => {
  // GitHub marks a thread outdated when the line moved, which is exactly what
  // happens when the agent pushes a fix without answering the reviewer.
  const pr = linkPr(202);
  const res = applyThreads(pr, [{
    threadKey: 'RT_outdated', path: 'src/b.ts', line: null, isResolved: false, isOutdated: true,
    commentCount: 2, author: 'reviewer', bodyExcerpt: 'still wrong',
  }]);
  assert.equal(res.newlyUnresolved.length, 1);
  assert.equal(res.newlyUnresolved[0].isOutdated, true);
});

test('a deleted thread stops being counted', () => {
  const pr = linkPr(203);
  applyThreads(pr, [{ threadKey: 'RT_gone', isResolved: false }]);
  assert.equal(applyThreads(pr, []).unresolvedCount, 0);
});

// -----------------------------------------------------------------------------

test('the watch list resolves the owning session through the head commit', () => {
  const session = spawnSession('lane-a-owner');
  const pr = linkPr(301);

  // No provenance yet: the PR is watched, but there is nobody to tell.
  let target = targetFor(pr);
  assert.ok(target, 'a tracked open PR is on the watch list');
  assert.equal(target.owningSessionId, null);

  // 082 §B's door: the session's worktree produced this commit.
  ok(`select public.record_session_commit(${uuid(session)}, 'acme/forge', ${literal(SHA_A)})`, {
    claims: w.claimsA,
  });
  ok(`select public.apply_pull_request_facts(${uuid(pr)}, null, null, ${literal(SHA_A)})`, {
    claims: w.claimsA,
  });

  target = targetFor(pr);
  assert.equal(target.owningSessionId, session, 'session -> commit -> PR head is the provenance path');
  assert.equal(target.owningSessionLive, true);
  assert.equal(target.taskId, w.taskA);
});

test('liveness outranks confidence, and an exited session is reported dead', () => {
  const session = spawnSession('lane-a-exiting');
  const pr = linkPr(302);
  ok(`select public.record_session_commit(${uuid(session)}, 'acme/forge', ${literal(SHA_B)})`, {
    claims: w.claimsA,
  });
  ok(`select public.apply_pull_request_facts(${uuid(pr)}, null, null, ${literal(SHA_B)})`, {
    claims: w.claimsA,
  });
  assert.equal(targetFor(pr).owningSessionLive, true);

  ok(`select public.work_session_transition(${uuid(session)}, 'exited', 0)`, { claims: w.claimsA });
  const after = targetFor(pr);
  assert.equal(after.owningSessionStatus, 'exited');
  assert.equal(after.owningSessionLive, false, 'a nudge to an exited session has no reader');
});

test('a PR based on another OPEN PR\u2019s branch is stacked', () => {
  const parent = linkPr(401);
  const child = linkPr(402);
  ok(
    `select public.apply_pull_request_facts(${uuid(parent)}, null, 'open', null, null, 'feat/parent', 'main', 'clean')`,
    { claims: w.claimsA },
  );
  ok(
    `select public.apply_pull_request_facts(${uuid(child)}, null, 'open', null, null, 'feat/child', 'feat/parent', 'dirty')`,
    { claims: w.claimsA },
  );

  assert.equal(targetFor(child).stackedOnOpenParent, true, 'base is an open PR\u2019s head');
  assert.equal(targetFor(parent).stackedOnOpenParent, false, 'main is not a pull request');

  // The parent merges. The child's conflict is now its own problem, so the
  // suppression must lift — a suppression that never ends is a silenced loop.
  ok(`select public.apply_pull_request_facts(${uuid(parent)}, null, 'merged')`, { claims: w.claimsA });
  assert.equal(targetFor(child).stackedOnOpenParent, false, 'a merged parent stops suppressing');
});

test('a merged pull request leaves the watch list', () => {
  const pr = linkPr(403);
  assert.ok(targetFor(pr));
  ok(`select public.apply_pull_request_facts(${uuid(pr)}, null, 'merged')`, { claims: w.claimsA });
  assert.equal(targetFor(pr), null);
});

test('an untracked pull request is never watched', () => {
  // Created directly, with no `tracks` edge: there is no task to close a loop
  // around, so polling it would spend rate limit on a nudge with no addressee.
  const id = scalar(
    `select internal.create_envelope(${uuid(w.spaceA)}, 'pull_request', ${uuid(w.memberA)}, null, null)`,
    { url: OWNER_URL },
  );
  ok(
    `insert into public.pull_requests(entity_id, space_id, provider, url, repo, number, title, state)
     values (${uuid(id)}, ${uuid(w.spaceA)}, 'github', 'https://x/1', 'acme/forge', 9001, 'orphan', 'open')`,
    { url: OWNER_URL },
  );
  assert.equal(targetFor(id), null);
});

// -----------------------------------------------------------------------------

test('a nudge signature is claimable exactly once', () => {
  const session = spawnSession('lane-a-dedup');
  const claim = (sig, cap = null) =>
    json(
      `select public.claim_session_nudge(${uuid(session)}, 'ci_failure', 'build@abc', ${literal(sig)},
         ${cap === null ? 'null' : cap})`,
      { claims: w.claimsA },
    );

  assert.equal(claim('sig-1').claimed, true);
  const again = claim('sig-1');
  assert.equal(again.claimed, false);
  assert.equal(again.reason, 'duplicate', 'this is the anti-respam invariant, durably');

  // A DIFFERENT signature on the same scope still gets through: the job failed
  // again for a different reason, and that is a second thing to fix.
  assert.equal(claim('sig-2').claimed, true);
});

test('the per-scope cap stops a review thread from being re-announced forever', () => {
  const session = spawnSession('lane-a-cap');
  const claim = (sig) =>
    json(
      `select public.claim_session_nudge(${uuid(session)}, 'review_thread', 'RT_capped', ${literal(sig)}, 2)`,
      { claims: w.claimsA },
    );
  assert.equal(claim('r1').claimed, true);
  assert.equal(claim('r2').claimed, true);
  const third = claim('r3');
  assert.equal(third.claimed, false);
  assert.equal(third.reason, 'capped');
  assert.equal(third.scopeCount, 2);
});

test('releasing a claim makes it claimable again', () => {
  // The post failed. Without the release the agent is never told, because the
  // dedup row asserts it already was.
  const session = spawnSession('lane-a-release');
  const args = `${uuid(session)}, 'merge_conflict', 'conflict@abc', 'sig-r'`;
  assert.equal(json(`select public.claim_session_nudge(${args}, null)`, { claims: w.claimsA }).claimed, true);
  assert.equal(json(`select public.release_session_nudge(${args})`, { claims: w.claimsA }).released, true);
  assert.equal(json(`select public.claim_session_nudge(${args}, null)`, { claims: w.claimsA }).claimed, true);
});

test('the door itself refuses a session that is not live', () => {
  const session = spawnSession('lane-a-dead');
  ok(`select public.work_session_transition(${uuid(session)}, 'exited', 0)`, { claims: w.claimsA });
  const res = json(
    `select public.claim_session_nudge(${uuid(session)}, 'ci_failure', 's', 'sig', null)`,
    { claims: w.claimsA },
  );
  assert.equal(res.claimed, false);
  assert.equal(res.reason, 'session_not_live');
  assert.equal(res.sessionStatus, 'exited');
});

test('nudge signatures survive as rows — this is what a restart reads', () => {
  const session = spawnSession('lane-a-durable');
  json(
    `select public.claim_session_nudge(${uuid(session)}, 'ci_failure', 'build@xyz', 'durable-sig', null)`,
    { claims: w.claimsA },
  );
  assert.equal(
    Number(scalar(
      `select count(*) from public.session_nudge_signatures
        where work_session_id = ${uuid(session)} and signature = 'durable-sig'`,
      { url: OWNER_URL },
    )),
    1,
    'in-memory dedup is dedup a deploy erases',
  );
});

// -----------------------------------------------------------------------------

test('the etag cache stores, returns and counts its 304s', () => {
  const key = 'gh:pr:acme/forge#501';
  ok(`select public.provider_etag_record(${uuid(w.spaceA)}, ${literal(key)}, 'W/"abc123"', false)`, {
    claims: w.claimsA,
  });
  assert.equal(
    json(`select public.provider_etag_lookup(${uuid(w.spaceA)}, array[${literal(key)}])`, {
      claims: w.claimsA,
    })[key],
    'W/"abc123"',
  );

  ok(`select public.provider_etag_record(${uuid(w.spaceA)}, ${literal(key)}, null, true)`, {
    claims: w.claimsA,
  });
  const row = json(
    `select to_jsonb(t) from public.provider_etags t
      where space_id = ${uuid(w.spaceA)} and resource_key = ${literal(key)}`,
    { url: OWNER_URL },
  );
  assert.equal(row.not_modified_hits, 1);
  assert.equal(row.etag, 'W/"abc123"', 'a 304 carries the same validator; rewriting it loses nothing but lies about freshness');

  // A 200 with no validator: forget it, rather than keep one that would produce
  // a bogus 304 next tick.
  ok(`select public.provider_etag_record(${uuid(w.spaceA)}, ${literal(key)}, null, false)`, {
    claims: w.claimsA,
  });
  assert.deepEqual(
    json(`select public.provider_etag_lookup(${uuid(w.spaceA)}, array[${literal(key)}])`, {
      claims: w.claimsA,
    }),
    {},
  );
});

test('a lookup for an unknown key is an empty object, not a failure', () => {
  assert.deepEqual(
    json(`select public.provider_etag_lookup(${uuid(w.spaceA)}, array['gh:pr:nope#1'])`, {
      claims: w.claimsA,
    }),
    {},
  );
});

// -----------------------------------------------------------------------------
// 083 (credential sessions) INTERACTION. Its header rules that anything which
// assumed "a work_sessions row is an agent" must narrow on `session_kind`, and
// this lane is squarely that: a credential login terminal has no agent reading
// its anchor, so a nudge routed to one closes no loop.
//
// The predicate is created conditionally (084 §F0) because this branch predates
// 083, so the assertion adapts: where the column exists, a credential session
// must be refused; where it does not, every session is an agent and the door
// behaves as it did before 083 was written. Both are stated, so whichever tree
// this runs on the test says something true.
// -----------------------------------------------------------------------------

const hasSessionKind = scalar(
  `select exists (select 1 from information_schema.columns
     where table_schema = 'public' and table_name = 'work_sessions'
       and column_name = 'session_kind')`,
  { url: OWNER_URL },
) === 't';

test('a credential login terminal is never nudged and never owns a PR', (t) => {
  if (!hasSessionKind) {
    t.skip('work_sessions.session_kind absent — this tree predates 083');
    return;
  }
  const session = spawnSession('lane-a-credential');
  // Flip it to a credential terminal directly: 083's own door mints these, and
  // borrowing it here would couple this suite to that migration's call shape.
  ok(
    `update public.work_sessions set session_kind = 'credential' where entity_id = ${uuid(session)}`,
    { url: OWNER_URL },
  );

  const res = json(
    `select public.claim_session_nudge(${uuid(session)}, 'ci_failure', 's', 'sig-cred', null)`,
    { claims: w.claimsA },
  );
  assert.equal(res.claimed, false);
  assert.equal(res.reason, 'not_an_agent_session', 'live by status is not the same as able to act');

  // And it must not be selected as an owner in the first place.
  const pr = linkPr(501);
  ok(`select public.record_session_commit(${uuid(session)}, 'acme/forge', ${literal('c'.repeat(40))})`, {
    claims: w.claimsA,
  });
  ok(`select public.apply_pull_request_facts(${uuid(pr)}, null, null, ${literal('c'.repeat(40))})`, {
    claims: w.claimsA,
  });
  assert.equal(targetFor(pr).owningSessionId, null, 'a credential terminal is not a candidate owner');
});

test('an agent session is still selected once 083 is in the chain', (t) => {
  if (!hasSessionKind) {
    t.skip('work_sessions.session_kind absent — this tree predates 083');
    return;
  }
  // The other half of the narrowing: it must not filter out real agents, which
  // is the failure mode 083's header warns about by name.
  const session = spawnSession('lane-a-agent-after-083');
  const pr = linkPr(502);
  ok(`select public.record_session_commit(${uuid(session)}, 'acme/forge', ${literal('d'.repeat(40))})`, {
    claims: w.claimsA,
  });
  ok(`select public.apply_pull_request_facts(${uuid(pr)}, null, null, ${literal('d'.repeat(40))})`, {
    claims: w.claimsA,
  });
  assert.equal(targetFor(pr).owningSessionId, session);
  assert.equal(targetFor(pr).owningSessionLive, true);
});
