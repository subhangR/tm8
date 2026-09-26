/**
 * PER-OPERATION AVAILABILITY — the permanent field, not scaffolding.
 *
 * What has to hold, and why each one is a correctness rule rather than a
 * preference:
 *
 *  - the DEFAULT is `unknown`, and `unknown` stays `unknown`. An optimistic
 *    `available` would make the field actively harmful, because a caller would
 *    branch on it.
 *  - PRECEDENCE is contract → observed → advertised, and a contract verdict is
 *    FINAL. No observation may promote a reserved row.
 *  - only `not_implemented` proves absence. Every other outcome — success or
 *    any other refusal — proves a handler ran.
 *  - the IMPLEMENTATION EPOCH is not the CAPABILITY EPOCH. A change in one must
 *    not disturb the other's cache.
 */
import { describe, expect, it } from 'vitest';
import {
  AVAILABILITIES,
  AVAILABILITY_SOURCES,
  AvailabilityLedger,
  contractAvailability,
  implementationEpoch,
  implementationEpochKey,
  readImplementationEpoch,
  resolveAvailability,
} from '../src/discovery/availability.js';
import { discovery, discoveryFor } from '../src/discovery/operations.js';

describe('the default is unknown, and unknown is never upgraded', () => {
  it('an untouched ledger answers unknown for every non-reserved row', () => {
    const fresh = new AvailabilityLedger();
    const rows = discovery(fresh);
    const unknown = rows.filter((r) => r.availability === 'unknown');
    const unavailable = rows.filter((r) => r.availability === 'unavailable');
    // 121 -> 126 (2026-08-02): auth.* Identity v2 Stage 1 (4 ops, all public, all with commands).
    // 126 -> 127 (2026-08-02): execution.launch (public, with a command).
    // 127 -> 128 (2026-08-09): execution.transcript (public, with a command).
    // 128 -> 129 (2026-08-09): projects.branches.list (public, with a command).
    // 129 -> 131 (2026-08-09): projects.contention + entities.commands.gate.
    // 131 -> 135: credentials.* Tier B (4 public, settings-only operations).
    // 135 -> 137: projects.files.list/attach (public, UI-only operations).
    // 137 -> 138: execution.dispatch (public, `session dispatch`).
    // 142 -> 144 (2026-08-12): collections.addItem/removeItem.
    // 144 -> 150 (2026-08-12, Git UI landing): the six execution.git* rows.
    // 172 -> 197 (2026-09-03, containers): the 25 containers.* rows. MEASURED.
    // 197 -> 198 (187, work session sharing): execution.sessions.share — public,
    // non-reserved, so BOTH counts move by one. The reserved pair is unmoved:
    // whether a member may watch another member's terminal is decided in the
    // database, not by withholding the row from the catalog. MEASURED.
    // 198 -> 199 (Changes screen Phase 1): execution.gitStage, the index verb
    // behind the Changes surface — public, v1, deliberately commandless like the
    // rest of the session git rail. Non-reserved too, so it moves BOTH counts a
    // second time. MEASURED from this file's own failing run on the MERGED tree.
    expect(rows).toHaveLength(255); /* +1 node.metrics.get (status strip). MEASURED. */ /* W11: +4 (projects.link stays, decision 29) spaces.projects.list|create and gate.folders.list|create. MEASURED. */ /* +1 auth.space.enter (W3-server). MEASURED. */ /* +3 spaces.leave, spaces.members.remove, accounts.disable (G6, 232). MEASURED. */ /* +2 spaces.chatDefaults.get/set (entity chat G). MEASURED. */ /* +1 launch.defaults (I9b), on the merged tree. MEASURED. */ /* +2 forms.responses.redeliver, forms.pendingForSessions (Forms W3), on the merged tree. MEASURED. */ /* +2 entities.header.set/clear (headers I4). MEASURED. */ /* +13 forms.* (Forms W1). MEASURED. */ /* +1 spaces.configs (task 01a0d350). MEASURED. */ /* +1 entities.commands.tick (bug 01a0d2f1). MEASURED. */ // +10 credentials.space.* + node.credentials.* (SC-3). MEASURED. // +3 credentials.serviceKeys.* (Jev lane K). MEASURED. // // +9 skills.* rows (2026-09-23, #647 + #649); /* +1 events.changes (change feed step 3). MEASURED. */ +1 launch.suggest (Jev lane F). MEASURED. /* +2 auth.sessions.list/revoke (W4). MEASURED. */ /* -1 containers.attention (Attention v2 S7a). MEASURED. */
    expect(unavailable.map((r) => r.operation).sort()).toEqual(['bridge.fetchBlob', 'search.query']);
    // 170 -> 195 -> 196 -> 197: all 25 containers.* rows, 187's, and
    // execution.gitStage are non-reserved. MEASURED.
    // 196 -> 197 (2026-09-19, Changes screen Phase 1 INTEGRATED WITH main): nothing is optimistically available, gitStage included. MEASURED.
    expect(unknown).toHaveLength(253); /* +1 node.metrics.get (status strip). MEASURED. */ /* W11: +4 (projects.link stays, decision 29) spaces.projects.list|create and gate.folders.list|create. MEASURED. */ /* +1 auth.space.enter (W3-server). MEASURED. */ /* +3 spaces.leave, spaces.members.remove, accounts.disable (G6, 232). MEASURED. */ /* +2 spaces.chatDefaults.get/set (entity chat G). MEASURED. */ /* +1 launch.defaults (I9b), on the merged tree. MEASURED. */ /* Forms W3 + headers I4, on the merged tree. MEASURED. */ /* +2 entities.header.set/clear (headers I4). MEASURED. */ /* +13 forms.* (Forms W1). MEASURED. */ /* +1 spaces.configs (task 01a0d350). MEASURED. */ // +10 (SC-3). MEASURED. // +3 credentials.serviceKeys.* (Jev lane K). MEASURED. // // +9 skills (2026-09-23); /* +1 events.changes (change feed step 3). MEASURED. */ +1 launch.suggest (Jev lane F). MEASURED. /* +1 entities.commands.tick (bug 01a0d2f1). MEASURED. */ /* +2 auth.sessions.list/revoke (W4). MEASURED. */ /* -1 containers.attention (Attention v2 S7a). MEASURED. */
    // The point of the field: NOTHING is optimistically available.
    expect(rows.filter((r) => r.availability === 'available')).toHaveLength(0);
  });

  it('unknown carries no reason and does not pretend to a source it did not use', () => {
    const fresh = new AvailabilityLedger();
    const d = discoveryFor('entities.get', fresh);
    expect(d.availability).toBe('unknown');
    expect(d.availabilityReason).toBeNull();
    expect(AVAILABILITIES).toContain(d.availability);
    expect(AVAILABILITY_SOURCES).toContain(d.availabilitySource);
    // The assertion this title always promised: nothing looked, so the source
    // is `none` — never `contract`, which declined to answer on this path.
    expect(d.availabilitySource).toBe('none');
  });
});

describe('source 1 — contract, offline and node-independent', () => {
  it('answers for the reserved rows with no ledger, no network, and no node', () => {
    expect(contractAvailability('reserved')).toEqual({
      availability: 'unavailable',
      availabilityReason: 'reserved',
      availabilitySource: 'contract',
    });
    expect(contractAvailability('v1')).toBeNull();
  });

  it('is FINAL: an observation cannot promote a reserved row to available', () => {
    const l = new AvailabilityLedger();
    l.record('search.query', 'handled');
    l.record('bridge.fetchBlob', 'handled');
    for (const name of ['search.query', 'bridge.fetchBlob'] as const) {
      const d = discoveryFor(name, l);
      expect(d.availability, name).toBe('unavailable');
      expect(d.availabilityReason, name).toBe('reserved');
      expect(d.availabilitySource, name).toBe('contract');
    }
  });
});

describe('source 2 — observed, a by-product of calls the caller already made', () => {
  it('an honest 501 marks that operation unavailable ON THIS NODE', () => {
    const l = new AvailabilityLedger();
    l.record('spaces.menu.get', 'not_implemented');
    const d = discoveryFor('spaces.menu.get', l);
    expect(d.availability).toBe('unavailable');
    expect(d.availabilityReason).toBe('not_implemented_on_node');
    expect(d.availabilitySource).toBe('observed');
  });

  it('any OTHER outcome proves a handler exists — including a refusal', () => {
    const l = new AvailabilityLedger();
    l.record('entities.get', 'handled');
    const d = discoveryFor('entities.get', l);
    expect(d.availability).toBe('available');
    expect(d.availabilityReason).toBe('observed_ok');
    expect(d.availabilitySource).toBe('observed');
  });

  it('one operation learned says NOTHING about its neighbours', () => {
    const l = new AvailabilityLedger();
    l.record('spaces.menu.get', 'not_implemented');
    expect(discoveryFor('spaces.menu.update', l).availability).toBe('unknown');
    expect(discoveryFor('spaces.get', l).availability).toBe('unknown');
  });
});

describe('source 3 — advertised, a reserved socket with nothing behind it', () => {
  it('is consulted only after observation, and today answers nothing', () => {
    const l = new AvailabilityLedger();
    expect(l.advertisedFor('entities.get')).toBeUndefined();
    expect(discoveryFor('entities.get', l).availability).toBe('unknown');
  });

  it('the seam is real code: a populated set resolves, and observation still wins', () => {
    const l = new AvailabilityLedger();
    l.setAdvertised({ implemented: new Set(['entities.get'] as const), epoch: 'adv_1' });
    expect(discoveryFor('entities.get', l).availabilitySource).toBe('advertised');
    expect(discoveryFor('entities.get', l).availability).toBe('available');
    expect(discoveryFor('spaces.get', l).availability).toBe('unavailable');
    // Precedence: an observation is closer to the truth than an advertisement.
    l.record('spaces.get', 'handled');
    expect(discoveryFor('spaces.get', l).availabilitySource).toBe('observed');
    expect(discoveryFor('spaces.get', l).availability).toBe('available');
  });
});

describe('/health is a cache-invalidation EPOCH, never a per-operation claim', () => {
  it('parses {operations, implemented}, and refuses to guess from anything else', () => {
    expect(readImplementationEpoch({ operations: 100, implemented: 28 })).toEqual(
      implementationEpoch(100, 28),
    );
    expect(readImplementationEpoch({ operations: 100 })).toBeNull();
    expect(readImplementationEpoch('ok')).toBeNull();
    expect(readImplementationEpoch(null)).toBeNull();
  });

  it('an UNCHANGED epoch keeps what was learned', () => {
    const l = new AvailabilityLedger();
    l.applyEpoch(implementationEpoch(100, 28));
    l.record('spaces.menu.get', 'not_implemented');
    l.applyEpoch(implementationEpoch(100, 28));
    expect(discoveryFor('spaces.menu.get', l).availability).toBe('unavailable');
  });

  it('a CHANGED epoch drops the learned set — the node moved, so the learning is stale', () => {
    const l = new AvailabilityLedger();
    l.applyEpoch(implementationEpoch(100, 28));
    l.record('spaces.menu.get', 'not_implemented');
    l.record('entities.get', 'handled');
    l.applyEpoch(implementationEpoch(100, 42));
    expect(discoveryFor('spaces.menu.get', l).availability).toBe('unknown');
    expect(discoveryFor('entities.get', l).availability).toBe('unknown');
  });

  it('the epoch NEVER becomes a per-operation claim: 28 of 101 names no operation', () => {
    const l = new AvailabilityLedger();
    l.applyEpoch(implementationEpoch(100, 28));
    const rows = discovery(l).filter((r) => r.availability !== 'unavailable');
    // Knowing 28 handlers exist tells you nothing about WHICH 28.
    expect(rows.every((r) => r.availability === 'unknown')).toBe(true);
    // 170 -> 195 -> 196: all 25 containers.* rows, and 187's, are non-reserved. MEASURED.
    // 170 -> 195: all 25 containers.* rows are non-reserved. MEASURED.
    // 195 -> 196 (Changes screen Phase 1): execution.gitStage is a v1,
    // non-reserved row, so it joins this population too. MEASURED.
    // 196 -> 197 (2026-09-19, Changes screen Phase 1 INTEGRATED WITH main): execution.gitStage is v1 and non-reserved. MEASURED.
    expect(rows).toHaveLength(253); /* +1 node.metrics.get (status strip). MEASURED. */ /* W11: +4 (projects.link stays, decision 29) spaces.projects.list|create and gate.folders.list|create. MEASURED. */ /* +1 auth.space.enter (W3-server). MEASURED. */ /* +3 spaces.leave, spaces.members.remove, accounts.disable (G6, 232). MEASURED. */ /* +2 spaces.chatDefaults.get/set (entity chat G). MEASURED. */ /* +1 launch.defaults (I9b), on the merged tree. MEASURED. */ /* Forms W3 + headers I4, on the merged tree. MEASURED. */ /* +2 entities.header.set/clear (headers I4). MEASURED. */ /* +13 forms.* (Forms W1). MEASURED. */ /* +1 spaces.configs (task 01a0d350). MEASURED. */ /* +1 entities.commands.tick (bug 01a0d2f1). MEASURED. */ // +10 credentials.space.* + node.credentials.* (SC-3). MEASURED. // +3 credentials.serviceKeys.* (Jev lane K). MEASURED. // // +9 skills.* rows (2026-09-23, #647 + #649); /* +1 events.changes (change feed step 3). MEASURED. */ +1 launch.suggest (Jev lane F). MEASURED. /* +2 auth.sessions.list/revoke (W4). MEASURED. */ /* -1 containers.attention (Attention v2 S7a). MEASURED. */
  });

  it('the implementation epoch key is distinctly prefixed and cannot read as a capabilityEpoch', () => {
    const key = implementationEpochKey(implementationEpoch(100, 28));
    expect(key).toBe('impl:100/28');
    expect(key).not.toMatch(/^cap_/);
  });

  it('a capabilityEpoch change does not disturb implementation availability', () => {
    // §8.2: static help stays valid when only `capabilityEpoch` changes. The
    // ledger has no capabilityEpoch input AT ALL, which is the strongest form
    // of that guarantee — the two caches cannot be coupled by accident.
    const l = new AvailabilityLedger();
    l.record('entities.get', 'handled');
    const before = l.revision();
    // There is deliberately no `applyCapabilityEpoch` to call here.
    expect(Object.keys(l)).not.toContain('capabilityEpoch');
    expect(l.revision()).toBe(before);
    expect(discoveryFor('entities.get', l).availability).toBe('available');
  });
});

describe('the ledger never probes', () => {
  it('exposes no method that issues a call', () => {
    const l = new AvailabilityLedger();
    const methods = Object.getOwnPropertyNames(AvailabilityLedger.prototype);
    expect(methods.sort()).toEqual([
      'advertisedFor',
      'applyEpoch',
      'clear',
      'constructor',
      'currentEpoch',
      'observed',
      'record',
      'revision',
      'setAdvertised',
    ]);
    expect(l.currentEpoch()).toBeNull();
  });

  it('resolveAvailability is pure: same inputs, same verdict, no side effects', () => {
    const l = new AvailabilityLedger();
    const a = resolveAvailability('entities.get', 'v1', l);
    const b = resolveAvailability('entities.get', 'v1', l);
    expect(a).toEqual(b);
    expect(l.revision()).toBe(0);
  });
});
