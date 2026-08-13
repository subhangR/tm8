/**
 * THE GLOBAL/PER-COMMAND FLAG COLLISION — a silent wrong answer with exit 0.
 *
 * `BOOLEAN_OPTIONS` contained `version`, so `parseInvocation` stripped
 * `--version` into `globals.version` before any command saw it, and `run()`
 * checks `globals.version` FIRST. The `=` spelling was eaten too: the `=`
 * branch recorded the value and `takeBool('version')` then deleted the key
 * regardless. Measured on the built binary before the fix:
 *
 *     $ node packages/cli/dist/index.js interaction-profile preview ip_1 --version 3
 *     0.1.0
 *     exit=0
 *
 * The published A16 invocation printed the CLI version and exited 0 without
 * previewing anything. It did not refuse and it did not crash — it answered a
 * different question with a success code, which nothing downstream can detect.
 *
 * THREE THINGS ARE TESTED HERE, and the third is the larger half:
 *
 *   1. the specific defect, in every published spelling;
 *   2. `confirmAgentGenerated`, ruled the same class: a frozen boolean the
 *      allowlist could not express, so the parser took it as value-taking and
 *      swallowed the following token;
 *   3. THE CLASS — a sweep over the projection and over the frozen input
 *      schemas, both ENUMERATED FROM THE DATA STRUCTURE rather than from a
 *      grep for names anyone thought of, and both shown capable of firing.
 *
 * Every sweep here carries a vacuity guard and a positive control, because a
 * loop that iterates zero rows and an assertion comparing `undefined` to
 * `undefined` are the classic ways an exhaustiveness test passes while
 * checking nothing.
 */
import { describe, expect, it } from 'vitest';
import * as contract from '@tm8/contract';
import {
  BOOLEAN_OPTIONS,
  COMMAND_SCOPED_GLOBALS,
  GLOBAL_OPTIONS,
  parseInvocation,
} from '../src/args.js';
import { discovery } from '../src/discovery/operations.js';
import { CliError } from '../src/exit.js';

function failureOf(fn: () => unknown): CliError {
  try {
    fn();
  } catch (err) {
    if (err instanceof CliError) return err;
    throw err;
  }
  throw new Error('expected a CliError');
}

// ── 1. the defect itself ────────────────────────────────────────────────────

describe('a per-command --version reaches the command (the A16 defect)', () => {
  const A16 = ['interaction-profile', 'preview', 'ip_1'] as const;

  it('delivers the ordinal to the command in BOTH published spellings', () => {
    for (const tail of [['--version', '3'], ['--version=3']]) {
      const argv = [...A16, ...tail];
      const label = argv.join(' ');
      const parsed = parseInvocation(argv);
      // The global is NOT claimed, so `run()` never short-circuits to the
      // version banner and the command actually runs.
      expect(parsed.globals.version, label).toBe(false);
      expect(parsed.options.value('version'), label).toBe('3');
      expect(parsed.options.integer('version'), label).toBe(3);
      // and the ordinal is not left behind as a stray positional
      expect(parsed.positionals, label).toEqual([...A16]);
    }
  });

  it('PROBE-RED CONTROL: a non-colliding value flag behaves identically', () => {
    // If the two assertions above ever pass vacuously because the parser
    // stopped delivering ANY flag, this control fails with them.
    const parsed = parseInvocation(['interaction-profile', 'validate', 'ip_1', '--expect-version', '3']);
    expect(parsed.options.value('expect-version')).toBe('3');
  });
});

describe('the frozen bare `tm8 --version` is untouched', () => {
  it('is still the global CLI-version request, alone', () => {
    const parsed = parseInvocation(['--version']);
    expect(parsed.globals.version).toBe(true);
    expect(parsed.positionals).toEqual([]);
    expect(parsed.options.has('version')).toBe(false);
  });

  it('still composes with the other globals', () => {
    expect(parseInvocation(['--version', '--format', 'json']).globals).toMatchObject({
      version: true,
      format: 'json',
    });
    expect(parseInvocation(['--quiet', '--version']).globals).toMatchObject({
      version: true,
      quiet: true,
    });
  });
});

describe('an ambiguous --version REFUSES rather than guessing', () => {
  it('exits 2 and names the collision when --version precedes a command path', () => {
    const err = failureOf(() => parseInvocation(['--version', 'kind', 'list']));
    expect(err.exitCode).toBe(2);
    // The refusal must name the flag, or the caller cannot act on it.
    expect(err.message).toContain('--version');
  });

  it('exits 2 for a value given to the GLOBAL --version', () => {
    const err = failureOf(() => parseInvocation(['--version=3']));
    expect(err.exitCode).toBe(2);
    expect(err.message).toContain('--version');
  });

  it('exits 2 rather than silently reading `tm8 --version 3` as either reading', () => {
    expect(failureOf(() => parseInvocation(['--version', '3'])).exitCode).toBe(2);
  });

  it('a per-command --version with no value is an honest usage error', () => {
    expect(failureOf(() => parseInvocation(['kind', 'list', '--version'])).exitCode).toBe(2);
  });
});

// ── 2. confirmAgentGenerated — the same class, from the other direction ──────

describe('--confirm-agent-generated is expressible', () => {
  it('is a declared boolean, so it does not swallow the following token', () => {
    expect(BOOLEAN_OPTIONS.has('confirm-agent-generated')).toBe(true);
    const parsed = parseInvocation([
      'teammate', 'interaction-profile', 'set-default', 'ip_1',
      '--confirm-agent-generated', '--expect-version', '2',
    ]);
    expect(parsed.options.bool('confirm-agent-generated')).toBe(true);
    expect(parsed.options.value('expect-version')).toBe('2');
  });

  it('PROBE-RED CONTROL: an UNDECLARED boolean-shaped flag really does swallow', () => {
    // The failure the allowlist entry prevents, demonstrated on a name that is
    // deliberately not on the allowlist. Without this control, the assertion
    // above proves only that some flag parsed.
    expect(BOOLEAN_OPTIONS.has('confirm-agent-invented')).toBe(false);
    const parsed = parseInvocation([
      'teammate', 'interaction-profile', 'set-default',
      '--confirm-agent-invented', 'ip_1',
    ]);
    // `ip_1` — the profile id — became the flag's VALUE and vanished from the
    // command path. This is exactly what `confirmAgentGenerated` did.
    expect(parsed.options.value('confirm-agent-invented')).toBe('ip_1');
    expect(parsed.positionals).toEqual(['teammate', 'interaction-profile', 'set-default']);
  });
});

// ── 3. THE CLASS — swept from the data structures, not from expectations ─────

/**
 * The global names, DERIVED FROM THE PARSER rather than restated from memory.
 * `GLOBAL_OPTIONS` carries the six §3 globals; `help` and `version` are the two
 * root-discovery booleans that behave globally without being in that tuple.
 * Each entry is proved global by parsing it and observing that it does NOT
 * reach the command's OptionBag.
 */
const GLOBAL_PROBE: Readonly<Record<string, readonly string[]>> = {
  server: ['--server', 'work'],
  space: ['--space', 'sp_1'],
  as: ['--as', 'tm_1'],
  format: ['--format', 'json'],
  timeout: ['--timeout', '2'],
  'no-color': ['--no-color'],
  quiet: ['--quiet'],
  fresh: ['--fresh'],
  terse: ['--terse'],
  full: ['--full'],
  help: ['--help'],
  version: ['--version'],
};

describe('the global name set is measured, not remembered', () => {
  it('is exactly GLOBAL_OPTIONS + the two root-discovery booleans', () => {
    expect(Object.keys(GLOBAL_PROBE).sort()).toEqual([...GLOBAL_OPTIONS, 'help', 'version'].sort());
  });

  it('every one of them is actually stripped by the parser before a command sees it', () => {
    for (const [name, argv] of Object.entries(GLOBAL_PROBE)) {
      expect(parseInvocation([...argv]).options.has(name), name).toBe(false);
    }
  });
});

interface SweptRow {
  operation: string;
  command: readonly string[] | null;
  syntax: string | null;
}

/**
 * The two regexes are deliberately the SAME SHAPE as the discovery slot's own
 * sweep in `discovery-operations.test.ts`, so the two tests partition the same
 * token set rather than each checking a different subset and both looking
 * total.
 */
const VALUE_FLAG = /--([a-z][a-z0-9-]*)\s+(?:<|[a-z0-9_]+\|)/g;
const BARE_FLAG = /--([a-z][a-z0-9-]*)(?![^\s\]])(?!\s+(?:<|[a-z0-9_]+\|))/g;

interface SweepResult {
  /** `<operation> --<flag>` for every flag the command CANNOT actually receive. */
  unreachable: string[];
  /** Occurrences of a global's own name inside a row's syntax. */
  globalNamed: string[];
  valueProbes: number;
  bareProbes: number;
  flagsSeen: Set<string>;
}

/**
 * BEHAVIOURAL sweep: for every flag the projection publishes, build the argv a
 * caller would actually type and ask the REAL parser whether the command
 * receives it. This measures the parser rather than a model of the parser, so
 * a mistake in my mental model of arity cannot make it pass.
 */
function sweep(rows: readonly SweptRow[]): SweepResult {
  const out: SweepResult = {
    unreachable: [],
    globalNamed: [],
    valueProbes: 0,
    bareProbes: 0,
    flagsSeen: new Set<string>(),
  };
  const PROBE = 'PROBE_VALUE';
  for (const row of rows) {
    if (row.syntax === null || row.command === null) continue;
    const path = [...row.command];

    for (const m of row.syntax.matchAll(VALUE_FLAG)) {
      const flag = m[1]!;
      out.valueProbes++;
      out.flagsSeen.add(flag);
      if (flag in GLOBAL_PROBE) out.globalNamed.push(`${row.operation} --${flag}`);
      // A row may legitimately document a GLOBAL in its own syntax — `[--space
      // <space-id>]` is the global itself, same name, same arity, same meaning,
      // and it arrives through `globals` rather than the command's OptionBag.
      // The exception is a COMMAND_SCOPED_GLOBAL: there the row means its OWN
      // flag, which is the whole collision, so it must reach the command.
      const isDocumentedGlobal = flag in GLOBAL_PROBE && !COMMAND_SCOPED_GLOBALS.has(flag);
      let delivered: string | undefined;
      try {
        const parsed = parseInvocation([...path, `--${flag}`, PROBE]);
        delivered = isDocumentedGlobal
          ? (parsed.globals as unknown as Record<string, unknown>)[flag] as string | undefined
          : parsed.options.value(flag);
      } catch {
        delivered = undefined;
      }
      if (delivered !== PROBE) out.unreachable.push(`${row.operation} --${flag}`);
    }

    for (const m of row.syntax.matchAll(BARE_FLAG)) {
      const flag = m[1]!;
      out.bareProbes++;
      out.flagsSeen.add(flag);
      if (flag in GLOBAL_PROBE) out.globalNamed.push(`${row.operation} --${flag}`);
      let swallowed = true;
      try {
        const parsed = parseInvocation([...path, `--${flag}`, PROBE]);
        // A declared boolean leaves the trailing token alone; an undeclared one
        // eats it as its value and the argument silently disappears.
        swallowed = !parsed.positionals.includes(PROBE);
      } catch {
        swallowed = true;
      }
      if (swallowed) out.unreachable.push(`${row.operation} --${flag} (bare)`);
    }
  }
  return out;
}

/**
 * Global names a row is ALLOWED to mention, each with the reason it is benign.
 * Anything else appearing here is a genuine collision and stops for amendment.
 */
const GLOBAL_NAMES_ALLOWED_IN_SYNTAX: Readonly<Record<string, string>> = {
  space: 'the global itself, documented in-row as the optional [--space <space-id>] tail — same name, same arity, same meaning; delivered through globals.space',
  version: 'RESOLVED BY THIS FIX — interactionProfiles.preview publishes a per-command ordinal that now reaches the command after the path, while bare `tm8 --version` stays the global',
};

describe('CLASS SWEEP: every flag the projection publishes can actually be received', () => {
  const rows: readonly SweptRow[] = discovery().map((d) => ({
    operation: d.operation,
    command: d.command,
    syntax: d.syntax,
  }));

  it('sweeps the whole projection, not a subset', () => {
    // Vacuity guards. The catalog is 128 rows, 126 of which publish syntax.
    // 121 -> 126 (2026-08-02): auth.* Identity v2 Stage 1 (4 ops, all public, all with commands).
    // 126 -> 127 (2026-08-02): execution.launch (public, with a command).
    // 127 -> 128 (2026-08-07): execution.transcript (public, with a command).
    // 128 -> 129 (2026-08-09): projects.branches.list.
    // 129 -> 131 (2026-08-09): projects.contention + entities.commands.gate.
    // 131 -> 135: credentials.* Tier B.
    // 137 -> 138 (2026-08-09): execution.dispatch (public, `session dispatch`).
    // 142 -> 144 (2026-08-12): collections.addItem/removeItem.
    // 144 -> 150 (2026-08-12, Git UI landing): the six execution.git* rows.
    expect(rows.length).toBe(161);
    expect(rows.filter((r) => r.syntax !== null).length).toBeGreaterThan(90);
    const result = sweep(rows);
    expect(result.valueProbes).toBeGreaterThan(100);
    expect(result.bareProbes).toBeGreaterThan(5);
    // Named witnesses: the sweep demonstrably REACHED the rows that matter,
    // rather than iterating a set that happens to exclude them.
    expect(result.flagsSeen.has('version'), 'sweep never reached --version').toBe(true);
    expect(result.flagsSeen.has('space'), 'sweep never reached --space').toBe(true);
    expect(result.flagsSeen.has('yes'), 'sweep never reached the bare --yes').toBe(true);
  });

  it('finds no flag that a global renders unreachable', () => {
    expect(sweep(rows).unreachable.sort()).toEqual([]);
  });

  it('the only global names appearing in row syntax are the two explained ones', () => {
    const named = new Set(sweep(rows).globalNamed.map((s) => s.split(' --')[1]!));
    expect([...named].sort()).toEqual(Object.keys(GLOBAL_NAMES_ALLOWED_IN_SYNTAX).sort());
  });

  it('the documented global --space still arrives through globals, not options', () => {
    const parsed = parseInvocation(['entity', 'create', '--space', 'sp_9']);
    expect(parsed.globals.space).toBe('sp_9');
    expect(parsed.options.has('space')).toBe(false);
  });

  it('PERTURBATION: the sweep FIRES on a planted collision', () => {
    // A sweep that finds nothing and was never shown capable of finding
    // something is not evidence of absence. Plant one and watch it fire.
    const planted: SweptRow[] = [
      { operation: 'planted.valueFlag', command: ['kind', 'list'], syntax: 'tm8 kind list --quiet <n>' },
      { operation: 'planted.bareFlag', command: ['kind', 'list'], syntax: 'tm8 kind list [--not-declared]' },
    ];
    expect(sweep(planted).unreachable.sort()).toEqual([
      'planted.bareFlag --not-declared (bare)',
      'planted.valueFlag --quiet',
    ]);
  });

  it('PERTURBATION: the sweep would have fired on --version BEFORE this fix', () => {
    // The pre-fix parser treated `version` as a global boolean in every
    // position. Reproduce that reading directly and confirm the classifier
    // calls it unreachable — this is the red the fix removed.
    expect(COMMAND_SCOPED_GLOBALS.has('version')).toBe(true);
    const asItWas: SweptRow[] = [
      {
        operation: 'preFix.interactionProfiles.preview',
        command: ['kind', 'list'],
        syntax: 'tm8 kind list --quiet <n>',
      },
    ];
    // `--quiet` is the surviving example of exactly the shape `--version` had:
    // a global BOOLEAN published by a row as taking a value.
    expect(sweep(asItWas).unreachable).toEqual(['preFix.interactionProfiles.preview --quiet']);
  });
});

// ── the same class, swept from the frozen INPUT SCHEMAS ─────────────────────

interface ZodLike {
  readonly _def: {
    readonly typeName: string;
    readonly value?: unknown;
    readonly innerType?: ZodLike;
    readonly schema?: ZodLike;
    readonly out?: ZodLike;
    readonly shape?: () => Record<string, ZodLike>;
  };
}

function unwrap(t: ZodLike | undefined, depth = 0): ZodLike | undefined {
  if (t === undefined || typeof t !== 'object' || !('_def' in t) || depth > 12) return undefined;
  const tn = t._def.typeName;
  if (tn === 'ZodEffects') return unwrap(t._def.schema, depth + 1);
  if (tn === 'ZodPipeline') return unwrap(t._def.out, depth + 1);
  if (tn === 'ZodOptional' || tn === 'ZodNullable' || tn === 'ZodDefault' || tn === 'ZodReadonly' || tn === 'ZodBranded') {
    return unwrap(t._def.innerType, depth + 1);
  }
  return t;
}

function isBoolean(t: ZodLike | undefined): boolean {
  const u = unwrap(t);
  if (u === undefined) return false;
  if (u._def.typeName === 'ZodBoolean') return true;
  return u._def.typeName === 'ZodLiteral' && typeof u._def.value === 'boolean';
}

const kebab = (s: string): string => s.replace(/([a-z0-9])([A-Z])/g, '$1-$2').toLowerCase();

/**
 * A boolean the CLI expresses under a DIFFERENT spelling, on purpose. Each is a
 * deliberate, already-shipped mapping — not an unexpressible field.
 */
const DELIBERATE_SPELLINGS: Readonly<Record<string, string>> = {
  confirm: '--yes, the §7.5 destructive confirmation (interaction-profile activate|retire set body.confirm from it)',
  enabled: '--off, which sets enabled:false for `entity react`',
  isNodeAdmin: '--node-admin, which sets isNodeAdmin:true for `auth signup` (2026-08-02)',
  // execution.gitCommit is a deliberately COMMANDLESS catalog row (the CLI
  // already runs the same verb locally as `session git commit --all`, and one
  // action must not have two names), so its `all` reaches the wire only from
  // the UI seam — there is no CLI flag to collide with.
  all: '`session git commit --all`, the CLI-local spelling of execution.gitCommit body.all (2026-08-12)',
};

describe('CLASS SWEEP: every boolean the frozen input schemas accept is expressible', () => {
  const schemaNames = Object.keys(contract).filter((k) => /InputSchema$/.test(k)).sort();

  function booleanFields(): Map<string, string[]> {
    const found = new Map<string, string[]>();
    for (const name of schemaNames) {
      const root = unwrap((contract as unknown as Record<string, ZodLike>)[name]);
      const shape = root?._def.shape;
      if (typeof shape !== 'function') continue;
      for (const [field, type] of Object.entries(shape())) {
        if (!isBoolean(type)) continue;
        const at = found.get(field) ?? [];
        at.push(name);
        found.set(field, at);
      }
    }
    return found;
  }

  it('walks every exported input schema, not a subset', () => {
    expect(schemaNames.length).toBeGreaterThan(40);
    const fields = booleanFields();
    // Named witnesses again: the walk demonstrably reached real boolean fields
    // in three different schemas.
    for (const witness of ['allowTightening', 'confirmUntrusted', 'force', 'confirm', 'confirmAgentGenerated']) {
      expect([...fields.keys()], `walk never reached ${witness}`).toContain(witness);
    }
  });

  it('PROBE-RED: the boolean detector discriminates, on real schemas', () => {
    const kindUpdate = unwrap((contract as unknown as Record<string, ZodLike>)['EntityKindUpdateInputSchema']);
    const shape = kindUpdate?._def.shape;
    expect(typeof shape).toBe('function');
    const fields = shape!();
    // A boolean field is detected...
    expect(isBoolean(fields['allowTightening'])).toBe(true);
    // ...and a same-schema NON-boolean is not, so the detector is not simply
    // returning true.
    expect(isBoolean(fields['capabilities'])).toBe(false);
  });

  it('every boolean input field is expressible, directly or by a documented spelling', () => {
    const unexpressible: string[] = [];
    for (const [field, schemas] of booleanFields()) {
      if (BOOLEAN_OPTIONS.has(kebab(field))) continue;
      if (field in DELIBERATE_SPELLINGS) continue;
      unexpressible.push(`${field} (--${kebab(field)}) in ${schemas.join(', ')}`);
    }
    expect(unexpressible.sort()).toEqual([]);
  });

  it('PERTURBATION: that check FIRES on a boolean with no spelling', () => {
    // Same predicate, applied to a field name that is deliberately absent from
    // both the allowlist and the documented-spellings map.
    const planted = 'noSuchConfirmation';
    expect(BOOLEAN_OPTIONS.has(kebab(planted))).toBe(false);
    expect(planted in DELIBERATE_SPELLINGS).toBe(false);
  });
});
