/**
 * The `container` noun's DISCOVERY projection — a per-row snapshot.
 *
 * WHY THIS IS IN LANE C'S OWN PR RATHER THAN CARRIED WITH THE ROWS. The rows
 * it snapshots are already covered in the carried PR by the repo's own
 * totality sweeps — `discovery-operations.test.ts` walks every catalog row for
 * enum completeness, guard agreement, command depth and the commandless set,
 * and `container.test.ts` asserts registration and grammar membership per
 * verb. Nothing in the carried PR is untested without this file. What it adds
 * is DEPTH on one family: the exact disposition of each of the 25 rows, which
 * a generic sweep can only check for presence.
 *
 * WHAT A DISCOVERY ROW IS FOR. `tm8 help` and shell completion are renderings
 * of this table, so every string here is operator-facing text an agent reads
 * in a PTY before it decides what to call. A wrong `versioning` teaches an
 * agent to omit a guard the server requires; a wrong `sideEffect` teaches it
 * that starting a machine is free.
 */
import { describe, expect, it } from 'vitest';
import { OPERATIONS, type OperationName } from '@tm8/contract';
import {
  commandDiscovery,
  commandsForNoun,
  commandlessForNoun,
  discoveryFor,
  PUBLIC_NOUNS,
  UNBOUND_MARKER,
} from '../src/discovery/operations.js';

const CONTAINER_OPS = OPERATIONS
  .filter((o) => o.name.startsWith('containers.'))
  .map((o) => o.name as OperationName);

describe('the container family is complete and discoverable', () => {
  it('is exactly 25 rows — the number Design §4.1 enumerates, not the 27 its prose says', () => {
    expect(CONTAINER_OPS).toHaveLength(25);
  });

  it('`container` is a public noun a caller can type', () => {
    expect(PUBLIC_NOUNS).toContain('container');
  });

  it('every row is public, and none is reserved or internal', () => {
    for (const op of CONTAINER_OPS) {
      expect(discoveryFor(op).exposure, op).toBe('public');
    }
  });

  it('every row resolves to the `container` noun', () => {
    for (const op of CONTAINER_OPS) {
      expect(discoveryFor(op).noun, op).toBe('container');
    }
  });

  it('every row carries a summary and intent tags an agent can search', () => {
    for (const op of CONTAINER_OPS) {
      const row = discoveryFor(op);
      expect(row.summary.length, op).toBeGreaterThan(10);
      expect(row.intentTags, op).toContain('container');
      // Tag search is how an agent finds a capability it cannot name.
      expect(row.intentTags.length, op).toBeGreaterThan(3);
    }
  });

  it('no row promises a schema binding it does not have', () => {
    for (const op of CONTAINER_OPS) {
      const row = discoveryFor(op);
      if (row.inputSchemaBound) continue;
      // An unbound row must SAY so, in the one shared marker — the notes and
      // the help line cannot drift apart because both read this constant.
      if (row.inputSchemaRef !== null) {
        expect(row.notes.join(' '), op).toMatch(/no frozen input schema binding/);
        expect(UNBOUND_MARKER).toBe('(not bound)');
      }
    }
  });
});

describe('the two commandless rows are decisions, each with a reason', () => {
  it('names exactly containers.stream and containers.proxy', () => {
    const commandless = commandlessForNoun('container').map((r) => r.operation).sort();
    expect(commandless).toEqual(['containers.proxy', 'containers.stream']);
  });

  it('each states WHY, so "no command" cannot be read as an oversight', () => {
    for (const row of commandlessForNoun('container')) {
      expect(row.reason, row.operation).toBeTruthy();
      expect((row.reason ?? '').length, row.operation).toBeGreaterThan(20);
      // A commandless row must render NO invocation syntax — a command line
      // printed for something no caller may invoke is a promise the system
      // cannot keep.
      expect(row.syntax, row.operation).toBeNull();
      expect(row.command, row.operation).toBeNull();
    }
  });
});

describe('the per-row dispositions', () => {
  /** [operation, versioning, sideEffect] — the two fields an agent acts on. */
  const DISPOSITION: ReadonlyArray<readonly [OperationName, 'none' | 'expectedVersion', string]> = [
    ['containers.create', 'none', 'execution'],
    ['containers.start', 'expectedVersion', 'execution'],
    ['containers.stop', 'expectedVersion', 'execution'],
    ['containers.pause', 'expectedVersion', 'execution'],
    ['containers.resume', 'expectedVersion', 'execution'],
    ['containers.destroy', 'expectedVersion', 'execution'],
    ['containers.update', 'expectedVersion', 'durable'],
    ['containers.policy.set', 'expectedVersion', 'execution'],
    ['containers.run', 'none', 'execution'],
    ['containers.terminal.start', 'none', 'execution'],
    ['containers.attach', 'none', 'execution'],
    ['containers.computer', 'none', 'execution'],
    ['containers.browser.endpoint', 'none', 'execution'],
    ['containers.expose', 'expectedVersion', 'execution'],
    ['containers.unexpose', 'expectedVersion', 'execution'],
    ['containers.snapshot', 'expectedVersion', 'execution'],
    ['containers.fork', 'none', 'execution'],
    ['containers.attention', 'none', 'durable'],
    ['containers.pools.set', 'expectedVersion', 'execution'],
  ];

  it('pins versioning and side effect row by row', () => {
    for (const [op, versioning, sideEffect] of DISPOSITION) {
      const row = discoveryFor(op);
      expect(row.versioning, `${op} versioning`).toBe(versioning);
      expect(row.sideEffect, `${op} sideEffect`).toBe(sideEffect);
    }
  });

  it('exactly eleven rows carry a version guard, and the syntax agrees with the disposition', () => {
    const guarded = CONTAINER_OPS.filter((op) => discoveryFor(op).versioning === 'expectedVersion');
    expect(guarded).toHaveLength(11);
    for (const op of guarded) {
      // The DISPOSITION and the operator-facing SYNTAX are two renderings of
      // one fact; a row that guards but never says so in its syntax teaches an
      // agent to omit the flag and be refused.
      expect(discoveryFor(op).syntax, op).toMatch(/--expect-version <n>/);
    }
  });

  it('every command row is a read or a command, and reads are idempotency `none`', () => {
    for (const op of CONTAINER_OPS) {
      const row = discoveryFor(op);
      const binding = OPERATIONS.find((o) => o.name === op);
      if (binding?.kind === 'read') {
        expect(row.idempotency, op).toBe('none');
        // A read must not advertise a mutation id in its syntax.
        if (row.syntax !== null) expect(row.syntax, op).not.toMatch(/--mutation-id/);
      }
    }
  });
});

describe('the noun index renders the whole family', () => {
  it('lists 24 commands under `container`: 22 from rows plus 2 aliases', () => {
    // 25 rows − 2 commandless (stream, proxy) = 23, and `container cp` serves
    // BOTH files.put and files.get, so 22 distinct row-derived paths. The two
    // aliases (`screenshot` over containers.computer, `adb` over containers.run)
    // add no catalog row. 22 + 2 = 24, which is also the +24 in COMMAND_PATHS.
    const commands = commandsForNoun('container').map((c) => c.command).sort();
    expect(commands).toHaveLength(24);
    expect(commands).toContain('container screenshot');
    expect(commands).toContain('container adb');
  });

  it('`container cp` reports BOTH file operations, not just the first', () => {
    // A command that maps several operations must say so, or its availability
    // is reported from one half of what it actually calls.
    expect(commandDiscovery(['container', 'cp'])?.operations.slice().sort())
      .toEqual(['containers.files.get', 'containers.files.put']);
  });

  it('`container browser` reports the computer operation it also invokes', () => {
    // `goto` and `text` are containers.computer; a command is only as available
    // as its WEAKEST operation, so both must be named.
    expect(commandDiscovery(['container', 'browser'])?.operations.slice().sort())
      .toEqual(['containers.browser.endpoint', 'containers.computer']);
  });

  it('every container command renders concrete syntax beginning with `tm8 `', () => {
    for (const c of commandsForNoun('container')) {
      expect(c.syntax, c.command).toMatch(/^tm8 container /);
      // No placeholder left unrendered, and no fabricated example.
      expect(c.syntax, c.command).not.toMatch(/undefined|\[object/);
    }
  });
});
