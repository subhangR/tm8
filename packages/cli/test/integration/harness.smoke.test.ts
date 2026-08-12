/** Coordinator smoke test for the integration harness itself. */
import { afterAll, beforeAll, expect, it } from 'vitest';
import { assertBuilt, cli, startRealServer, type RealServer } from './harness.js';

let server: RealServer;
beforeAll(async () => { await assertBuilt(); server = await startRealServer('smoke'); }, 120_000);
afterAll(async () => { await server?.stop(); });

it('captured a coherent migration-chain bind', async () => {
  console.log(`[harness] chain bind-start ${server.bindStart.files}/${server.bindStart.digest}`);
  expect(server.bindStart.files).toBeGreaterThan(0);
  // Throws if the chain moved under this suite — see assertBindCoherent.
  await server.assertBindCoherent();
});

it('starts a real Server and reports an un-enveloped /health', async () => {
  const h = await server.health();
  expect(h.ok).toBe(true);
  expect(h.server).toBe('tm8-server');
  // 136 -> 137 (2026-08-09): execution.dispatch. NOTE this counts ROUTES, not
  // catalog rows — the catalog is 138, of which `events.subscribe` is WS and
  // never becomes an HTTP route.
  expect(h.operations).toBe(156);
  expect(h.implemented).toBeGreaterThan(0);
  console.log(`[harness] ${server.baseUrl} operations=${h.operations} registered=${h.implemented}`);
});

it('the built CLI reaches it and honours the frozen exit table', async () => {
  const ok = await cli(['help'], server);
  expect(ok.code).toBe(0);
  const retired = await cli(['whoami'], server);
  expect(retired.code).toBe(2);
  const reserved = await cli(['search', 'query', 'x'], server);
  expect(reserved.code).toBe(8);
});

it('observes availability THREE-STATE and never over-claims', async () => {
  // A GET with no body reaches the handler, so this is a real observation.
  expect(await server.observe('identity.get')).toBe('available');
  // Reserved forever — 501 at the router, definitive.
  expect(await server.observe('search.query')).toBe('unavailable');
  // Uncomposed — 501 at the router, definitive. This assertion previously named
  // `entityKinds.create`, and it went RED the moment tranche-v3 composed G12:
  // the row moved 'unavailable' -> 'unknown'. That red was CORRECT — the probe
  // detecting that the world changed — and it is a second, independent witness
  // to a composition otherwise measured only by /health's count.
  //
  // ⚠⚠ THE ENDANGERMENT PREDICTED IN THE COMMENT ABOVE HAS NOW HAPPENED. RECORDED
  // RATHER THAN TIDIED AWAY, because the whole point of that warning was that a
  // silent deletion here would make a real coverage loss invisible.
  //
  // This line previously asserted `presence.get` -> 'unavailable'. It was the LAST
  // live end-to-end witness in the entire CLI to the OBSERVED -> 'unavailable'
  // derivation branch. G10 has now composed `presence.get`, so it answers
  // 'available' and the assertion went red — not because anything broke, but
  // because its subject was FIXED.
  //
  // WHAT IS PERMANENTLY LOST: no v1 operation can exercise the observed branch of
  // the DERIVATION any more. The only rows still answering 501 are the two
  // permanently reserved ones, and `resolveAvailability` short-circuits on the
  // CONTRACT source before observation is ever consulted for those. Nothing will
  // ever go red about this again.
  //
  // THE CLAIM IS THEREFORE SPLIT, because neither half can carry it alone:
  //   1. WIRING, still provable end-to-end and asserted below: a real 501 from a
  //      real Server does reach `observe()` and is classified 'unavailable'. The
  //      reserved row proves the transport->classification link survives.
  //   2. PRECEDENCE (observed -> 'unavailable' on a v1 row): unit coverage ONLY,
  //      in discovery-availability.test.ts, which drives the ledger directly.
  // The archived witness — captured before G10 landed, and now unreproducible by
  // anyone — is preserved verbatim in W4-CLI-IMPLEMENTATION-EVIDENCE.md §11.4.
  //
  // `presence.get` composing is asserted POSITIVELY so this transition is a fact
  // in the suite rather than a deletion in a diff.
  expect(await server.observe('presence.get')).toBe('available');
  // Two REGISTERED command handlers. An empty body fails input validation BEFORE
  // the handler runs, so the only honest answer for both is 'unknown' — never
  // 'available'. A boolean version of this probe reported a registered operation
  // as implemented, which is the defect the three-state API exists to prevent.
  //
  // HISTORICAL NOTE, kept because the comment would otherwise become a lie:
  // until tranche-v3, `messages.post` was an unconditional 501 STUB while
  // `spaces.create` was live, and this pair demonstrated that a stub and a live
  // handler are INDISTINGUISHABLE from an invalid body. `messages.post` is now the
  // real G04 handler, so that specific demonstration is no longer reproducible
  // here — there is no stub left to contrast against. The indistinguishability
  // claim now rests on unit coverage, not on this line.
  expect(await server.observe('messages.post')).toBe('unknown');
  expect(await server.observe('spaces.create')).toBe('unknown');
});
