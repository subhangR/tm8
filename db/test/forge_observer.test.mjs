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

import { OWNER_URL, buildWorld, json, literal, ok, rows, run, scalar, uuid } from './helpers.mjs';

const w = buildWorld('forge');

const SHA_A = 'a'.repeat(40);
const SHA_B = 'b'.repeat(40);

/**
 * Spawn a live session in space A. Returns the work_session entity id.
 *
 * Retires the previously spawned one first: 006's concurrency cap is 8 per
 * space and this suite needs more sessions than that over its life, but never
 * more than two at once. The exit is also free realism — a session that ended
 * is the normal case these doors have to handle.
 */
const spawned = [];
function spawnSession(title, { keepPrevious = false } = {}) {
  if (!keepPrevious) {
    for (const previous of spawned.splice(0)) {
      run(`select public.work_session_transition(${uuid(previous)}, 'exited', 0)`, {
        claims: w.claimsA,
      });
    }
  }
  const res = json(
    `select public.execution_spawn(${uuid(w.spaceA)}, ${uuid(w.personaA)}, array[${uuid(w.taskA)}]::uuid[],
       ${uuid(w.projectId)}, 'project', null, null, 'worker', null, null, ${literal(title)})`,
    { claims: w.claimsA },
  );
  const id = res.entity?.id ?? res.sessionId ?? res.entityId;
  spawned.push(id);
  return id;
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

/**
 * Queue a CI transition and hand back its pending id, so the dedup tests can
 * exercise the door without re-deriving the whole observation each time.
 */
function queueCiNudge(number, sessionId, sha, checkName = 'build') {
  const pr = linkPrOwnedBy(number, sessionId, sha);
  applyChecks(pr, sha, [{ name: checkName, status: 'completed', conclusion: 'failure' }]);
  const claimed = json(`select public.claim_pending_nudges(20, 48)`, { claims: w.claimsA }).pending;
  const row = claimed.find((r) => r.prEntityId === pr && r.scopeKey === `${checkName}@${sha}`);
  assert.ok(row, 'a live agent addressee means the transition is handed out');
  return { pr, pendingId: row.pendingId };
}

test('identical content is never said to the same session twice', () => {
  const session = spawnSession('lane-a-dedup');
  const first = queueCiNudge(701, session, '6'.repeat(40));
  assert.equal(
    json(`select public.post_session_nudge(${uuid(first.pendingId)}, 'sig-1', 'body', null, 'cmid-d1')`,
      { claims: w.claimsA }).posted,
    true,
  );

  // Fixed, then broken again at the same commit: a NEW transition, so a new
  // queue row — the partial index is what allows that.
  applyChecks(first.pr, '6'.repeat(40), [{ name: 'build', status: 'completed', conclusion: 'success' }]);
  applyChecks(first.pr, '6'.repeat(40), [{ name: 'build', status: 'completed', conclusion: 'failure' }]);
  const again = json(`select public.claim_pending_nudges(20, 48)`, { claims: w.claimsA })
    .pending.find((r) => r.prEntityId === first.pr);
  assert.ok(again, 'a re-break queues again');

  // Same signature ⇒ same words ⇒ refused, and the queue row is settled so it
  // is not retried forever.
  const dup = json(
    `select public.post_session_nudge(${uuid(again.pendingId)}, 'sig-1', 'body', null, 'cmid-d2')`,
    { claims: w.claimsA },
  );
  assert.equal(dup.posted, false);
  assert.equal(dup.reason, 'duplicate');
  assert.equal(
    rows(`select status, retire_reason from public.pending_session_nudges where id = ${uuid(again.pendingId)}`,
      { url: OWNER_URL })[0].retire_reason,
    'duplicate',
  );
});

test('a DIFFERENT signature on the same scope still gets through', () => {
  // The job failed again for a different reason. That is a second thing to fix.
  const session = spawnSession('lane-a-dedup-2');
  const first = queueCiNudge(702, session, '7'.repeat(40));
  json(`select public.post_session_nudge(${uuid(first.pendingId)}, 'sig-a', 'body a', null, 'cmid-d3')`,
    { claims: w.claimsA });
  applyChecks(first.pr, '7'.repeat(40), [{ name: 'build', status: 'completed', conclusion: 'success' }]);
  applyChecks(first.pr, '7'.repeat(40), [{ name: 'build', status: 'completed', conclusion: 'failure' }]);
  const again = json(`select public.claim_pending_nudges(20, 48)`, { claims: w.claimsA })
    .pending.find((r) => r.prEntityId === first.pr);
  assert.equal(
    json(`select public.post_session_nudge(${uuid(again.pendingId)}, 'sig-b', 'body b', null, 'cmid-d4')`,
      { claims: w.claimsA }).posted,
    true,
  );
});

test('the per-scope cap stops a thread from being re-announced forever', () => {
  const session = spawnSession('lane-a-cap');
  const pr = linkPrOwnedBy(703, session, '8'.repeat(40));
  const open = [{ threadKey: 'RT_cap', path: 'a.ts', isResolved: false, commentCount: 1,
                  author: 'r', bodyExcerpt: 'fix this' }];
  const queueThread = () => {
    applyThreads(pr, open);
    return json(`select public.claim_pending_nudges(20, 48)`, { claims: w.claimsA })
      .pending.find((r) => r.prEntityId === pr && r.loopKind === 'review_thread');
  };

  let row = queueThread();
  assert.equal(json(`select public.post_session_nudge(${uuid(row.pendingId)}, 'rt-1', 'b1', 2, 'cmid-c1')`,
    { claims: w.claimsA }).posted, true);
  applyThreads(pr, [{ ...open[0], isResolved: true }]);
  row = queueThread();
  assert.equal(json(`select public.post_session_nudge(${uuid(row.pendingId)}, 'rt-2', 'b2', 2, 'cmid-c2')`,
    { claims: w.claimsA }).posted, true);
  applyThreads(pr, [{ ...open[0], isResolved: true }]);
  row = queueThread();
  const third = json(`select public.post_session_nudge(${uuid(row.pendingId)}, 'rt-3', 'b3', 2, 'cmid-c3')`,
    { claims: w.claimsA });
  assert.equal(third.posted, false);
  assert.equal(third.reason, 'capped');
});

test('the door refuses a session that is not live', () => {
  const session = spawnSession('lane-a-dead-door');
  const queued = queueCiNudge(704, session, '9'.repeat(40));
  ok(`select public.work_session_transition(${uuid(session)}, 'exited', 0)`, { claims: w.claimsA });
  const res = json(
    `select public.post_session_nudge(${uuid(queued.pendingId)}, 'sig-dead', 'body', null, 'cmid-dead')`,
    { claims: w.claimsA },
  );
  assert.equal(res.posted, false);
  // Either answer is correct and both mean "nobody can act": the session may
  // resolve as not-live, or stop resolving as the owner at all.
  assert.ok(['session_not_live', 'no_owning_session'].includes(res.reason), res.reason);
});

test('delivered signatures survive as rows — this is what a restart reads', () => {
  const session = spawnSession('lane-a-durable');
  const queued = queueCiNudge(705, session, 'a1'.repeat(20));
  json(`select public.post_session_nudge(${uuid(queued.pendingId)}, 'durable-sig', 'body', null, 'cmid-dur')`,
    { claims: w.claimsA });
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

  // It must not be selected as an owner in the first place, which is the
  // check that matters — the door's own refusal is the belt under it.
  const pr = linkPr(501);
  ok(`select public.record_session_commit(${uuid(session)}, 'acme/forge', ${literal('cc'.repeat(20))})`, {
    claims: w.claimsA,
  });
  ok(`select public.apply_pull_request_facts(${uuid(pr)}, null, null, ${literal('cc'.repeat(20))})`, {
    claims: w.claimsA,
  });
  assert.equal(targetFor(pr).owningSessionId, null, 'a credential terminal is not a candidate owner');

  // And the door refuses one directly, so a caller that resolved an addressee
  // some other way still cannot deliver into a login terminal.
  applyChecks(pr, 'cc'.repeat(20), [
    { name: 'build', status: 'completed', conclusion: 'failure' },
  ]);
  const queued = rows(
    `select id from public.pending_session_nudges where pr_entity_id = ${uuid(pr)} and status = 'pending'`,
    { url: OWNER_URL },
  );
  assert.equal(queued.length, 1, 'the transition is queued even with no valid addressee');
  const refused = json(
    `select public.post_session_nudge(${uuid(queued[0].id)}, 'sig-cred', 'body', null, 'cmid-cred')`,
    { claims: w.claimsA },
  );
  assert.equal(refused.posted, false);
  assert.equal(refused.reason, 'no_owning_session',
    'a credential terminal is not an addressee, so there is no owner at all');
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

// =============================================================================
// THE TEST THAT WOULD HAVE CAUGHT THE BLOCKER.
//
// Every nudge assertion before this one drove a MOCKED db.rpc, so they proved
// what arguments the observer passes and nothing about whether the call can
// succeed. It could not: migration 019 revoked `post_message` from tm8_app, and
// the delivery path called it. A mock cannot fail a grant.
//
// So these run AS tm8_app — the role PgDb actually connects as — against a
// chain-built database, and assert the message ROW LANDS. The inverse is
// pinned too: the raw door must still be refused, because the day someone
// "fixes" this by re-granting it is the day nudges silently stop being
// delivered to terminals (019 mints the delivery intent, post_message does not).
// =============================================================================

/** Link a PR the way production does, so `created_in` provenance exists. */
function linkPrOwnedBy(number, sessionId, sha) {
  const pr = linkPr(number);
  ok(`select public.record_session_commit(${uuid(sessionId)}, 'acme/forge', ${literal(sha)})`, {
    claims: w.claimsA,
  });
  ok(`select public.apply_pull_request_facts(${uuid(pr)}, null, 'open', ${literal(sha)})`, {
    claims: w.claimsA,
  });
  return pr;
}

const pendingFor = (prId) =>
  rows(
    `select id, loop_kind, scope_key, status, retire_reason, head_sha
       from public.pending_session_nudges where pr_entity_id = ${uuid(prId)}`,
    { url: OWNER_URL },
  );

test('BLOCKING REGRESSION — tm8_app cannot call post_message directly', () => {
  // 019 closed the message write surface deliberately: w2_post_message_batch is
  // the only door that mints a delivery intent for a work_session anchor. If
  // this assertion ever fails, check WHY the grant came back before celebrating.
  const session = spawnSession('lane-a-grant-pin');
  const res = run(`select public.post_message(${uuid(session)}, 'direct')`, {
    claims: w.claimsA,
    verbose: true,
  });
  assert.equal(res.ok, false, 'post_message must stay revoked from tm8_app');
  assert.match(res.stderr, /permission denied/i);
});

test('BLOCKING REGRESSION — a nudge posts AS tm8_app and the message row lands', () => {
  const session = spawnSession('lane-a-real-delivery');
  const pr = linkPrOwnedBy(601, session, 'e'.repeat(40));

  // A red check enqueues a transition in the same statement as the facts.
  applyChecks(pr, 'e'.repeat(40), [
    { name: 'build', status: 'completed', conclusion: 'failure', externalId: '9001' },
  ]);
  const queued = pendingFor(pr);
  assert.equal(queued.length, 1, 'the transition is durable, not just returned');
  assert.equal(queued[0].status, 'pending');

  const claimed = json(`select public.claim_pending_nudges(10, 48)`, { claims: w.claimsA }).pending;
  const mine = claimed.find((row) => row.prEntityId === pr);
  assert.ok(mine, 'a live agent addressee means the row is handed out');
  assert.equal(mine.owningSessionId, session);

  // THE CALL THAT USED TO ANSWER 42501.
  const posted = json(
    `select public.post_session_nudge(${uuid(mine.pendingId)}, 'sig-real', 'CI FAILED on acme/forge#601', null, 'cmid-nudge-real-1')`,
    { claims: w.claimsA },
  );
  assert.equal(posted.posted, true, 'the door must succeed as tm8_app');
  assert.ok(posted.messageId, 'a message id comes back');

  // The row is really there, on the session anchor, readable.
  const message = json(
    `select to_jsonb(m) from public.messages m where m.entity_id = ${uuid(posted.messageId)}`,
    { url: OWNER_URL },
  );
  assert.equal(message.anchor_id, session);
  assert.match(message.body, /CI FAILED/);

  // And the queue row is settled, so it is not delivered twice.
  assert.equal(pendingFor(pr)[0].status, 'delivered');
});

test('the same signature is refused, and the queue row says why', () => {
  const session = spawnSession('lane-a-real-dedup');
  const pr = linkPrOwnedBy(602, session, 'f'.repeat(40));
  applyChecks(pr, 'f'.repeat(40), [{ name: 'build', status: 'completed', conclusion: 'failure' }]);
  let mine = json(`select public.claim_pending_nudges(10, 48)`, { claims: w.claimsA })
    .pending.find((row) => row.prEntityId === pr);
  json(
    `select public.post_session_nudge(${uuid(mine.pendingId)}, 'sig-dup', 'body one', null, 'cmid-dup-1')`,
    { claims: w.claimsA },
  );

  // Re-enqueue the same transition by re-detecting it after a resolve/re-break.
  applyChecks(pr, 'f'.repeat(40), [{ name: 'build', status: 'completed', conclusion: 'success' }]);
  applyChecks(pr, 'f'.repeat(40), [{ name: 'build', status: 'completed', conclusion: 'failure' }]);
  mine = json(`select public.claim_pending_nudges(10, 48)`, { claims: w.claimsA })
    .pending.find((row) => row.prEntityId === pr);
  assert.ok(mine, 'the re-break is a new queued transition');

  const again = json(
    `select public.post_session_nudge(${uuid(mine.pendingId)}, 'sig-dup', 'body one', null, 'cmid-dup-2')`,
    { claims: w.claimsA },
  );
  assert.equal(again.posted, false);
  assert.equal(again.reason, 'duplicate', 'identical content is not said twice');
});

test('BLOCKING — a transition detected with NO live session survives to be told later', () => {
  // This is the integrator rig's shape, and the reason the outbox exists: the
  // old code suppressed the nudge and the fact was already stored, so nothing
  // ever re-announced it.
  const session = spawnSession('lane-a-no-addressee');
  const pr = linkPrOwnedBy(603, session, '1'.repeat(40));
  ok(`select public.work_session_transition(${uuid(session)}, 'exited', 0)`, { claims: w.claimsA });

  applyChecks(pr, '1'.repeat(40), [{ name: 'build', status: 'completed', conclusion: 'failure' }]);
  assert.equal(pendingFor(pr).length, 1, 'detected with nobody to tell');

  // Nobody live ⇒ not handed out, and CRUCIALLY still pending.
  const none = json(`select public.claim_pending_nudges(10, 48)`, { claims: w.claimsA })
    .pending.filter((row) => row.prEntityId === pr);
  assert.deepEqual(none, [], 'no addressee means no delivery');
  assert.equal(pendingFor(pr)[0].status, 'pending', 'and the transition is NOT consumed');

  // A NEW session picks the lane back up. Note it cannot inherit the commit —
  // 082 gives a commit exactly one birth session, deliberately — so ownership
  // arrives by the branch route (081 §A6): the session is working in a worktree
  // checked out on this PR's head branch. That is what resuming a lane looks
  // like in production.
  const revived = spawnSession('lane-a-revived', { keepPrevious: true });
  ok(
    `select public.apply_pull_request_facts(${uuid(pr)}, null, null, null, null, 'feat/pr-603', 'main', null)`,
    { claims: w.claimsA },
  );
  const worktree = scalar(
    `select internal.create_envelope(${uuid(w.spaceA)}, 'worktree', ${uuid(w.memberA)}, null, null)`,
    { url: OWNER_URL },
  );
  ok(
    `insert into public.worktrees(entity_id, project_id, path, branch, base_ref, base_commit_oid)
     values (${uuid(worktree)}, ${uuid(w.projectId)}, '/tmp/tm8-lane-a-603', 'feat/pr-603', 'main', ${literal('9'.repeat(40))})`,
    { url: OWNER_URL },
  );
  ok(`select public.link_session_worktree(${uuid(revived)}, ${uuid(worktree)})`, {
    claims: w.claimsA,
  });
  const now = json(`select public.claim_pending_nudges(10, 48)`, { claims: w.claimsA })
    .pending.filter((row) => row.prEntityId === pr);
  assert.equal(now.length, 1, 'the transition is told when an addressee appears');
  assert.equal(now[0].owningSessionId, revived);
});

test('a queued nudge is retired when the head moves past it', () => {
  const session = spawnSession('lane-a-stale-head');
  const pr = linkPrOwnedBy(604, session, '2'.repeat(40));
  applyChecks(pr, '2'.repeat(40), [{ name: 'build', status: 'completed', conclusion: 'failure' }]);
  assert.equal(pendingFor(pr)[0].status, 'pending');

  // The agent pushed a fix. The old red check no longer describes the code, so
  // announcing it now would send them to fix a build that no longer exists.
  ok(`select public.apply_pull_request_facts(${uuid(pr)}, null, null, ${literal('3'.repeat(40))})`, {
    claims: w.claimsA,
  });
  json(`select public.retire_stale_pending_nudges(48)`, { claims: w.claimsA });
  const row = pendingFor(pr).find((r) => r.head_sha === '2'.repeat(40));
  assert.equal(row.status, 'retired');
  assert.equal(row.retire_reason, 'head_moved');
});

test('a merged pull request retires everything queued for it', () => {
  const session = spawnSession('lane-a-settled');
  const pr = linkPrOwnedBy(605, session, '4'.repeat(40));
  applyChecks(pr, '4'.repeat(40), [{ name: 'build', status: 'completed', conclusion: 'failure' }]);
  ok(`select public.apply_pull_request_facts(${uuid(pr)}, null, 'merged')`, { claims: w.claimsA });
  json(`select public.retire_stale_pending_nudges(48)`, { claims: w.claimsA });
  assert.equal(pendingFor(pr)[0].retire_reason, 'pr_settled');
});

test('a conflict transition is queued by the fact door itself', () => {
  const session = spawnSession('lane-a-conflict-queue');
  const pr = linkPrOwnedBy(606, session, '5'.repeat(40));
  ok(
    `select public.apply_pull_request_facts(${uuid(pr)}, null, null, null, null, 'feat/x', 'main', 'clean')`,
    { claims: w.claimsA },
  );
  assert.deepEqual(pendingFor(pr).filter((r) => r.loop_kind === 'merge_conflict'), []);

  ok(
    `select public.apply_pull_request_facts(${uuid(pr)}, null, null, null, null, null, null, 'dirty')`,
    { claims: w.claimsA },
  );
  const conflict = pendingFor(pr).filter((r) => r.loop_kind === 'merge_conflict');
  assert.equal(conflict.length, 1, 'clean -> dirty is a queued transition');

  // Staying dirty is not a second transition.
  ok(
    `select public.apply_pull_request_facts(${uuid(pr)}, null, null, null, null, null, null, 'dirty')`,
    { claims: w.claimsA },
  );
  assert.equal(pendingFor(pr).filter((r) => r.loop_kind === 'merge_conflict').length, 1);
});
