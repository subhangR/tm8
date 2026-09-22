/**
 * THE `INPUT_SCHEMAS` SEAM — the one every other test went around.
 *
 * ── WHAT WENT WRONG, AND WHY NOTHING WAS RED ──────────────────────────────
 * `execution.gitStage` grew a `hunks` key on its contract type
 * (`contract.ts`, `ExecutionGitStageInput`) and `ExecutionGitStageInputSchema`
 * — which is `.strict()` — was never extended with it. Every hunk-staging
 * request therefore died at `server.ts:400` with
 * `Unrecognized key(s) in object: 'hunks'`, and the PR's headline feature was
 * unreachable over HTTP while its unit tests were green.
 *
 * The compiler cannot catch this class, and it is worth being precise about
 * why rather than calling it a zod quirk. The binding is
 * `z.ZodType<ExecutionGitStageInput>`, and `ZodType` is COVARIANT in its
 * output type. A schema that parses to `{action, paths, all}` is assignable to
 * `ZodType<{action, paths, all, hunks?}>`, because every value it produces IS
 * a valid `ExecutionGitStageInput` — one that simply never sets the optional
 * field. Nothing is unsound; the annotation just cannot express "and it must
 * ACCEPT `hunks` too". A REQUIRED key would have been caught. An OPTIONAL key
 * is invisible, which is exactly the shape a new feature arrives in.
 *
 * ── WHY THE EXISTING TESTS COULD NOT SEE IT ───────────────────────────────
 * They construct a typed `ExecutionGitStageInput` and hand it to the handler
 * as `ctx.body`. That is going AROUND this seam: the handler never parses, so
 * the schema is never asked. It is a real test of the handler and no test at
 * all of reachability. The two halves have to meet somewhere, and the only
 * place they meet in production is the two lines below.
 *
 * ── HOW THIS FILE RESOLVES THE SCHEMA, AND WHY IT MATTERS ─────────────────
 * `server.ts:399-400` does exactly this, and so does this file:
 *
 *     const schema = INPUT_SCHEMAS[match.opName];
 *     const input  = schema ? validate(schema, requestBody) : requestBody;
 *
 * Keyed by the OPERATION NAME STRING, not by importing the schema binding
 * directly. Importing `ExecutionGitStageInputSchema` and parsing against it
 * would prove the schema accepts a body while proving nothing about whether
 * that schema is what guards `execution.gitStage` — a mis-keyed table entry
 * would sail through. The lookup is half of what is under test.
 *
 * `validate` itself is module-private in `server.ts`, so its two lines are
 * reproduced in `validateLikeServer` below; the assertion is on `safeParse`,
 * which is the whole of its behaviour that can reject.
 */
import ts from 'typescript';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { ZodTypeAny } from 'zod';
import * as contract from '@tm8/contract';
import { INPUT_SCHEMAS } from '../../src/facade/input-schemas.js';

/** `server.ts:466` — the parse half of the gate, which is the half that rejects. */
function validateLikeServer(schema: ZodTypeAny, body: unknown): { ok: true; data: unknown } | { ok: false; issues: string } {
  const parsed = schema.safeParse(body);
  return parsed.success
    ? { ok: true, data: parsed.data }
    : { ok: false, issues: parsed.error.issues.map((i) => i.message).join('; ') };
}

/** The lookup `server.ts:399` performs, by operation name. */
function gate(opName: string): ZodTypeAny {
  const schema = (INPUT_SCHEMAS as Record<string, ZodTypeAny | undefined>)[opName];
  // An absent binding is NOT a pass. `execution.resume` shipped with no
  // server-side validation for exactly this reason, and a test that treated
  // "no schema" as "nothing to check" is what let it.
  expect(schema, `${opName} has no INPUT_SCHEMAS binding, so nothing guards its body`).toBeDefined();
  return schema as ZodTypeAny;
}

describe('execution.gitStage THROUGH the INPUT_SCHEMAS gate', () => {
  /**
   * THE REGRESSION. Red before the schema was extended, with the message a
   * real client received: `Unrecognized key(s) in object: 'hunks'`.
   */
  it('ACCEPTS a hunk-staging body — the headline feature must reach the handler', () => {
    const result = validateLikeServer(gate('execution.gitStage'), {
      clientMutationId: 'stage-hunks-1',
      action: 'stage',
      hunks: { path: 'src/a.ts', indices: [1, 3], digest: 'sha256:abc' },
    });
    expect(result.ok ? null : result.issues).toBeNull();
  });

  /**
   * THE CONTROL, and it is the reason the failure above is attributable.
   * This body was accepted BEFORE the fix too. Had the fix worked by relaxing
   * `.strict()`, both cases would pass and the suite would be worthless — so
   * the rejection cases below are what hold the fix to its actual shape.
   */
  it('still ACCEPTS a whole-file body (the control that did not move)', () => {
    const result = validateLikeServer(gate('execution.gitStage'), {
      clientMutationId: 'stage-files-1',
      action: 'stage',
      paths: ['src/a.ts'],
    });
    expect(result.ok ? null : result.issues).toBeNull();
  });

  it('accepts a hunk selection with no digest — the field is optional by contract', () => {
    const result = validateLikeServer(gate('execution.gitStage'), {
      clientMutationId: 'stage-hunks-2',
      action: 'unstage',
      hunks: { path: 'src/a.ts', indices: [2] },
    });
    expect(result.ok ? null : result.issues).toBeNull();
  });

  /** `.strict()` must still be strict — the fix added a key, it did not open the object. */
  it('REJECTS an unknown top-level key', () => {
    const result = validateLikeServer(gate('execution.gitStage'), {
      clientMutationId: 'stage-bad-1',
      action: 'stage',
      paths: ['src/a.ts'],
      patch: 'diff --git a/etc/passwd b/etc/passwd',
    });
    expect(result.ok).toBe(false);
  });

  /**
   * And strict INSIDE the selection. This is the security posture of the verb
   * written as an assertion: the wire carries INDICES, never patch text,
   * because a patch reaching `git apply --cached` is a write primitive for any
   * path in the repository. A non-strict nested object would silently carry a
   * `patch` key to a handler that might one day read it.
   */
  it('REJECTS an unknown key inside hunks', () => {
    const result = validateLikeServer(gate('execution.gitStage'), {
      clientMutationId: 'stage-bad-2',
      action: 'stage',
      hunks: { path: 'src/a.ts', indices: [1], patch: '@@ -1 +1 @@' },
    });
    expect(result.ok).toBe(false);
  });

  it('REJECTS a hunk selection with no path', () => {
    const result = validateLikeServer(gate('execution.gitStage'), {
      clientMutationId: 'stage-bad-3',
      action: 'stage',
      hunks: { indices: [1] },
    });
    expect(result.ok).toBe(false);
  });

  /**
   * NOT a schema concern, and asserted here so the next reader does not
   * "tighten" it. `indices: []` and a non-integer index are refused by the
   * SERVICE, by name (`no_hunks_selected`, `invalid_hunk_index`), which a zod
   * error could not do — the same argument the schema already makes for the
   * empty `paths`/`all` pair. The gate's job is shape; which hunks exist is a
   * fact only the worktree has.
   */
  it('passes an empty indices array THROUGH — the service refuses it by name', () => {
    const result = validateLikeServer(gate('execution.gitStage'), {
      clientMutationId: 'stage-empty-1',
      action: 'stage',
      hunks: { path: 'src/a.ts', indices: [] },
    });
    expect(result.ok ? null : result.issues).toBeNull();
  });
});

/**
 * ── THE FIELD-PARITY GUARD ────────────────────────────────────────────────
 *
 * The test above is a regression test for ONE key on ONE operation. It would
 * not have prevented the defect, because nobody writes it until the defect
 * exists. This is the part that generalises: for every operation the server
 * guards, the zod object must accept exactly the fields its contract type
 * declares — no fewer (the `hunks` defect: a declared field the validator
 * refuses) and no more (a field the validator accepts and the contract never
 * promised).
 *
 * WHICH TYPE IT COMPARES AGAINST. `z.ZodType<Out, Def, In>` carries a third
 * parameter for schemas whose accepted INPUT differs from their parsed output.
 * The guard reads `In` when present and `Out` otherwise, because the gate
 * validates what arrives on the wire. This is not a loosening: `messages.post`
 * is bound as `z.ZodType<PostMessageInput, ZodTypeDef, PostMessageWireInput>`
 * and deliberately accepts a deprecated `anchorId` that its transform strips,
 * so comparing against `Out` reports a phantom extra field. Reading `In` is
 * reading the right type.
 *
 * WHY THE TYPE SIDE NEEDS A COMPILER. TypeScript types are erased, so there is
 * nothing to reflect on at runtime. The guard builds a `Program` over the
 * contract package and uses the CHECKER — not raw AST — so that
 * `CommandContext & {...}` intersections, `extends` clauses and unions resolve
 * to their real member sets rather than to whatever the declaration site spelt.
 */

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '../../../..');

/**
 * The keys a zod schema will ACCEPT at the top level, or `null` when the shape
 * is not an object-like the guard can read.
 *
 * A union contributes the union of its members' keys: the gate accepts a body
 * matching ANY branch, so a field present in one branch is accepted.
 */
function acceptedKeys(schema: unknown, depth = 0): Set<string> | null {
  const def = (schema as { _def?: { typeName?: string } } | null)?._def;
  if (def === undefined || depth > 6) return null;
  const s = schema as Record<string, any>;
  switch (def.typeName) {
    case 'ZodObject':
      return new Set(Object.keys(s.shape as Record<string, unknown>));
    // The INPUT of an effects schema is its inner schema — which is the point
    // for `messages.post`, whose refinement wraps the wire object.
    case 'ZodEffects':
      return acceptedKeys(s._def.schema, depth + 1);
    case 'ZodOptional':
    case 'ZodNullable':
    case 'ZodDefault':
    case 'ZodCatch':
    case 'ZodReadonly':
      return acceptedKeys(s._def.innerType, depth + 1);
    case 'ZodLazy':
      return acceptedKeys(s._def.getter(), depth + 1);
    case 'ZodPipeline':
      return acceptedKeys(s._def.in, depth + 1);
    case 'ZodUnion':
    case 'ZodDiscriminatedUnion': {
      const options: unknown[] = [...(s._def.options as Iterable<unknown>)];
      const out = new Set<string>();
      for (const option of options) {
        const keys = acceptedKeys(option, depth + 1);
        if (keys === null) return null;
        for (const k of keys) out.add(k);
      }
      return out;
    }
    case 'ZodIntersection': {
      const left = acceptedKeys(s._def.left, depth + 1);
      const right = acceptedKeys(s._def.right, depth + 1);
      if (left === null || right === null) return null;
      return new Set([...left, ...right]);
    }
    default:
      return null;
  }
}

/**
 * Operations whose bound schema is declared INSIDE `input-schemas.ts` rather
 * than in the contract, and so names no contract type to compare against.
 *
 * ENUMERATED, NOT SKIPPED, and the distinction is the lesson
 * `UNBOUND_COMMAND_OPERATIONS` already records in the file next door: the only
 * test over that list once pinned a hardcoded COUNT, the list claimed to be
 * empty while nine operations had no binding at all, and `execution.resume`
 * shipped unvalidated. So this set is asserted to match EXACTLY. A new
 * operation that lands here — because someone bound it to a local shape — must
 * be added deliberately, and cannot arrive as a silent gap in the guard's
 * coverage.
 *
 * All fourteen resolve to one of two local schemas, `RequiredCommandContext`
 * and `UndoCommandInput`. Neither is a defect; both are shapes the contract
 * does not name 1:1. They are simply outside what this guard can prove.
 *
 * `skills.scan` is the fifteenth and the exception to "two schemas": it binds
 * `SkillScanInputSchema`, declared beside its handler in `skills/handlers.ts`,
 * because the contract names the scan's RESULT, not its request.
 */
const NO_CONTRACT_TYPE_TO_COMPARE: readonly string[] = [
  'collections.removeItem',
  'commands.undo',
  'edges.delete',
  'entities.delete',
  'entities.restore',
  'projects.unlink',
  'readMarks.upsert',
  'savedViews.delete',
  'skills.scan',
  'spaces.invites.create',
  'spaces.invites.redeem',
  'spaces.invites.revoke',
  'spaces.taskAxes.delete',
  'spaces.taskWorkflows.delete',
  'spaces.workflows.delete',
];

interface ParityRow {
  op: string;
  typeName: string;
  missing: string[];
  extra: string[];
}

function runParityScan(): { rows: ParityRow[]; uncomparable: string[]; compared: number } {
  const configPath = resolve(REPO_ROOT, 'packages/contract/tsconfig.json');
  const parsed = ts.getParsedCommandLineOfConfigFile(configPath, {}, ts.sys as unknown as ts.ParseConfigFileHost);
  if (parsed === undefined) throw new Error(`could not read ${configPath}`);
  const program = ts.createProgram(parsed.fileNames, { ...parsed.options, noEmit: true });
  const checker = program.getTypeChecker();

  /** Exported schema NAME → the members of the type its binding declares. */
  const declaredFor = new Map<string, { typeName: string; props: Set<string> }>();
  for (const sourceFile of program.getSourceFiles()) {
    if (!sourceFile.fileName.includes('packages/contract/src')) continue;
    sourceFile.forEachChild((node) => {
      if (!ts.isVariableStatement(node)) return;
      for (const decl of node.declarationList.declarations) {
        if (!ts.isIdentifier(decl.name) || decl.type === undefined) continue;
        if (!ts.isTypeReferenceNode(decl.type)) continue;
        const args = decl.type.typeArguments;
        if (args === undefined || args.length === 0) continue;
        if (!/ZodType|ZodSchema/.test(decl.type.typeName.getText())) continue;
        // `In` when the binding declares one, else `Out` — see the note above.
        const arg = args[2] ?? args[0]!;
        const type = checker.getTypeFromTypeNode(arg);
        const props = new Set<string>();
        // A union contributes every member's properties, matching how
        // `acceptedKeys` treats a zod union.
        for (const part of type.isUnion() ? type.types : [type]) {
          for (const symbol of checker.getPropertiesOfType(part)) props.add(symbol.getName());
        }
        declaredFor.set(decl.name.text, { typeName: arg.getText(), props });
      }
    });
  }
  expect(declaredFor.size, 'no zod bindings found — the scan resolved nothing and would pass vacuously').toBeGreaterThan(100);

  /** Schema OBJECT → the name it is exported under, so a binding can be named. */
  const exportedAs = new Map<unknown, string>();
  for (const [name, value] of Object.entries(contract)) {
    if (value !== null && typeof value === 'object' && !exportedAs.has(value)) exportedAs.set(value, name);
  }

  const rows: ParityRow[] = [];
  const uncomparable: string[] = [];
  let compared = 0;

  for (const [op, schema] of Object.entries(INPUT_SCHEMAS as Record<string, ZodTypeAny>)) {
    const exportName = exportedAs.get(schema);
    const declared = exportName === undefined ? undefined : declaredFor.get(exportName);
    const accepted = acceptedKeys(schema);
    if (declared === undefined || accepted === null) {
      uncomparable.push(op);
      continue;
    }
    compared += 1;
    const missing = [...declared.props].filter((p) => !accepted.has(p)).sort();
    const extra = [...accepted].filter((k) => !declared.props.has(k)).sort();
    if (missing.length > 0 || extra.length > 0) {
      rows.push({ op, typeName: declared.typeName, missing, extra });
    }
  }
  return { rows, uncomparable, compared };
}

describe('INPUT_SCHEMAS field parity with the contract types', () => {
  const scan = runParityScan();

  /**
   * THE GUARD. `missing` is the `hunks` defect's exact shape — a field the
   * contract type declares and the `.strict()` validator refuses, which makes
   * the feature unreachable while every type in sight agrees. `extra` is its
   * mirror: a field the gate accepts that the contract never promised.
   */
  it('every comparable operation accepts exactly the fields its contract type declares', () => {
    const report = scan.rows.map((r) => {
      const parts = [
        r.missing.length > 0 ? `declared but NOT accepted: ${r.missing.join(', ')}` : '',
        r.extra.length > 0 ? `accepted but NOT declared: ${r.extra.join(', ')}` : '',
      ].filter((s) => s !== '');
      return `${r.op} (${r.typeName}) — ${parts.join(' | ')}`;
    });
    expect(report).toEqual([]);
  });

  /** A guard that compared nothing would pass. Pin the denominator. */
  it('compares the bulk of the guarded surface, not a handful', () => {
    expect(scan.compared).toBeGreaterThan(100);
    expect(scan.compared + scan.uncomparable.length).toBe(Object.keys(INPUT_SCHEMAS).length);
  });

  /** Exactly, for the reason in the comment on the constant. */
  it('the uncomparable set is exactly the enumerated local-schema operations', () => {
    expect([...scan.uncomparable].sort()).toEqual([...NO_CONTRACT_TYPE_TO_COMPARE].sort());
  });
});
