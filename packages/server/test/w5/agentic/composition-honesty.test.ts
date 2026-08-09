/**
 * W5 · DUO F · TESTER — the REPLACEMENT composition detector.
 *
 * WHY THIS FILE EXISTS, AND WHAT IT IS NOT.
 *
 * `packages/server/test/w2/reserved-honesty.test.ts` is FROZEN historical
 * evidence and IS NOT REPAIRED BY THIS FILE. It prints, at its `:99-102`
 * console.info, `mounted=97 residual=1 presence.get`, while a production node
 * mounts 98 with residual 0. NEITHER READING IS WRONG. They measure two
 * DIFFERENT COMPOSITIONS:
 *
 *   reserved-honesty.test.ts:66  registerEventHandlers(registry, { db, config })
 *   src/main.ts:148              registerEventHandlers(registry, { db, config, presence })
 *
 * and `src/events/handlers.ts:110-125` mounts `presence.get` if and only if a
 * presence source was supplied — deliberately, so that a node with no presence
 * source answers an honest 501 instead of an empty snapshot that cannot be told
 * apart from "nobody is here" (`handlers.ts:110-115`, `:37-40`).
 *
 * So the frozen file is not drifting from the truth; it is a detector wired to
 * a composition the product no longer boots. THE DEFECT IS THAT NOTHING SAYS
 * SO. A reader of that console line has no way to know which of the two worlds
 * it measured.
 *
 * WHAT THIS FILE DOES INSTEAD: it makes the composition an INPUT and pins BOTH
 * worlds by exact set. The known-bad half is a SYNTHETIC composition assembled
 * here, not a defect in any source file, so — per the standing orders §7d — NO
 * SOURCE CHANGE CAN EVER DESTROY THE RED HALF. A fix elsewhere cannot quietly
 * turn this detector into a one-legged one.
 *
 * WHAT THIS FILE CAN BE SATISFIED BY, before what it asserts:
 *   - It CAN be satisfied by a registry that mounts everything for a reason
 *     unrelated to presence. `DELTA` (below) excludes that: it asserts the two
 *     compositions differ by EXACTLY `presence.get` and nothing else, so a
 *     second, unrelated drift cannot hide inside a matching count. §3c — a
 *     count cannot detect a substitution.
 *   - It is evidence about WHICH OPERATIONS ARE MOUNTED. It is NOT evidence
 *     that any mounted handler does anything useful, and NOT evidence that any
 *     of them would succeed against a real database. `StubDb` returns empty for
 *     everything.
 *   - `mounted` here is `HandlerRegistry.implemented()`, i.e. registration.
 *     Registration is not reachability and is not correctness.
 */
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { OPERATIONS, type OperationName } from '@tm8/contract';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { Db, DbClaims, Querier } from '../../../src/db/types.js';
import { registerEventHandlers } from '../../../src/events/handlers.js';
import { InMemoryPresenceStore } from '../../../src/events/presence.js';
import { createExecutionRuntime } from '../../../src/facade/execution-handlers.js';
import { registerFacadeHandlers } from '../../../src/facade/index.js';
import { HandlerRegistry } from '../../../src/facade/registry.js';
import { createW2BlobStore } from '../../../src/files/w2-blob-store.js';
import type { ServerConfig } from '../../../src/http/config.js';

/**
 * The one row the two compositions differ by. FROZEN LITERAL (§6): if the
 * product ever mounts presence unconditionally, or gates a second operation on
 * a source, this literal goes red rather than a range quietly absorbing it.
 */
const PRESENCE_GATED = 'presence.get' as const;

class StubDb implements Db {
  async tx<T>(_claims: DbClaims, fn: (q: Querier) => Promise<T>): Promise<T> {
    return fn({ query: async <R>(): Promise<R[]> => [], rpc: async <T2>(): Promise<T2> => ({}) as T2 });
  }
  async query<R>(): Promise<R[]> {
    return [];
  }
  async rpc<T>(): Promise<T> {
    return {} as T;
  }
  async end(): Promise<void> {}
}

/**
 * The composition under test, with the presence source as an explicit
 * parameter. This mirrors `src/main.ts:140-150` — facade, events, execution —
 * and the ONLY thing that varies between the two worlds is `withPresence`.
 */
function compose(
  withPresence: boolean,
  db: Db,
  config: ServerConfig,
  dataDir: string,
): ReadonlySet<OperationName> {
  const registry = new HandlerRegistry();
  const blobStore = createW2BlobStore({ dataDir, maxSizeBytes: 4096 });
  registerFacadeHandlers(registry, { db, config, files: { blobStore, maxSizeBytes: 4096 } });
  registerEventHandlers(registry, {
    db,
    config,
    ...(withPresence ? { presence: new InMemoryPresenceStore() } : {}),
  });
  createExecutionRuntime({ db, config, dataDir }).register(registry);
  return new Set(registry.implemented());
}

/** Every v1 HTTP operation — the denominator both worlds are measured against. */
const REGISTERABLE: readonly OperationName[] = OPERATIONS.filter(
  ({ method, status }) => method !== 'WS' && status === 'v1',
).map(({ name }) => name as OperationName);

describe('W5.F composition honesty — the presence source is the whole delta', () => {
  let dataDir: string;
  let withPresence: ReadonlySet<OperationName>;
  let withoutPresence: ReadonlySet<OperationName>;

  beforeAll(async () => {
    dataDir = await mkdtemp(join(tmpdir(), 'tm8-w5f-comp-'));
    const config: ServerConfig = {
      host: '127.0.0.1',
      port: 0,
      uiDir: undefined,
      maxBodyBytes: 1024 * 1024,
      databaseUrl: undefined,
      dataDir,
      fileMaxSizeBytes: 4096,
    };
    const db = new StubDb();
    withPresence = compose(true, db, config, dataDir);
    withoutPresence = compose(false, db, config, dataDir);
  }, 60_000);

  afterAll(async () => {
    await rm(dataDir, { recursive: true, force: true });
  }, 30_000);

  // DENOMINATOR GENERATIONS, kept with cause (a maintained literal shows its
  // history): 98 (as authored — the 101-row catalog era) -> 99 (Delta 2 / A21:
  // the `execution.liveness` row joined `OPERATIONS`, the 101->102 family;
  // +1 registerable v1 HTTP) -> 107 -> 114 (2026-07-31, the consolidation
  // wave: serverConnections, artifacts, attention, voice et al). Mechanical
  // denominator moves only — the two-world presence semantics this file
  // measures are untouched.
  it('CONTROL — the denominator is the 125 v1 HTTP rows, by exact count and exact membership', () => {
    // 118 -> 122 (2026-08-02): the four auth.* rows (Identity v2 Stage 1).
    // 122 -> 123 (2026-08-02): execution.launch.
    // The 123 literal was ALREADY red at 124 when this lane arrived; 125 adds
    // execution.transcript.
    // 114 -> 118 (2026-08-01): execution.resume, spaces.counts,
    // execution.journal, identity.profile.update.
    // 125 -> 127 (2026-08-09): files.browse + files.read, both mounted.
    expect(REGISTERABLE).toHaveLength(127);
    expect(new Set(REGISTERABLE).size, 'no duplicate names in the denominator').toBe(127);
    expect(REGISTERABLE).toContain(PRESENCE_GATED);
  }, 15_000);

  it('KNOWN-GOOD world — WITH a presence source, residual is the EMPTY SET', () => {
    const residual = REGISTERABLE.filter((name) => !withPresence.has(name));
    expect(residual, `residual with presence: ${residual.join(',')}`).toEqual([]);
    expect(withPresence.size).toBe(127);
    expect(withPresence.has(PRESENCE_GATED)).toBe(true);
  }, 15_000);

  it('KNOWN-BAD world — WITHOUT a presence source, residual is EXACTLY [presence.get]', () => {
    const residual = REGISTERABLE.filter((name) => !withoutPresence.has(name));
    // An exact set, never a count. §3c: "EXACTLY ONE RESIDUAL" is satisfiable by
    // a substitution — a different operation going missing while presence.get
    // mounts would keep the count at 1 and this assertion would still catch it.
    expect(residual, `residual without presence: ${residual.join(',')}`).toEqual([PRESENCE_GATED]);
    expect(withoutPresence.size).toBe(126);
    expect(withoutPresence.has(PRESENCE_GATED)).toBe(false);
  }, 15_000);

  it('DELTA — the two worlds differ by exactly one row, in exactly one direction', () => {
    const onlyWith = [...withPresence].filter((n) => !withoutPresence.has(n)).sort();
    const onlyWithout = [...withoutPresence].filter((n) => !withPresence.has(n)).sort();

    // The load-bearing assertion of this file. It is what makes both halves
    // above mean what their names say: the presence source explains the ENTIRE
    // difference, so neither reading can be quietly caused by something else.
    expect(onlyWith, `mounted only WITH presence: ${onlyWith.join(',')}`).toEqual([PRESENCE_GATED]);
    expect(onlyWithout, `mounted only WITHOUT presence: ${onlyWithout.join(',')}`).toEqual([]);
  }, 15_000);

  it('BOTH READINGS ARE CORRECT — 125/0 and 124/1 name the two compositions, not a defect', () => {
    // The sentence the frozen file could not say, wired to something that
    // fails. `test/w2/reserved-honesty.test.ts` composes WITHOUT presence
    // (its `:66`); `src/main.ts:148` composes WITH it. This test asserts that
    // BOTH of those numbers are reachable from the SAME production code, which
    // is what makes "the frozen file drifted" the wrong diagnosis.
    expect([withPresence.size, 127 - withPresence.size]).toEqual([127, 0]);
    expect([withoutPresence.size, 127 - withoutPresence.size]).toEqual([126, 1]);
  }, 15_000);

  it('NO MOUNT ESCAPES THE DENOMINATOR — neither world mounts a WS or reserved row', () => {
    const denominator = new Set(REGISTERABLE);
    for (const [label, mounted] of [
      ['with presence', withPresence],
      ['without presence', withoutPresence],
    ] as const) {
      const stray = [...mounted].filter((n) => !denominator.has(n)).sort();
      expect(stray, `${label} mounted outside the v1 HTTP set: ${stray.join(',')}`).toEqual([]);
      expect(mounted.has('search.query' as OperationName), label).toBe(false);
      expect(mounted.has('bridge.fetchBlob' as OperationName), label).toBe(false);
      expect(mounted.has('events.subscribe' as OperationName), label).toBe(false);
    }
  }, 15_000);
});
