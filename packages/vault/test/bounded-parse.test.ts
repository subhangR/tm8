import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { VAULT_INPUT_SCHEMAS } from '@tm8/contract';
import { boundedSafeParse } from '../src/bounded-parse.js';
import { CapturePayloadSchema } from '../src/capture/payload.js';
import { validInput } from './broker/support.js';
import { trackedObjects, zodNodes } from './support/zod-walk.js';

// Review addendum 2, C4. zod 3.25.76 is in the range of GHSA-mrhx-c7xc-m3w5: it keeps every issue of
// every failing element, with no cap and no early stop. boundedSafeParse stops a parse once it passes
// a budget. Every value here is synthetic.

const OVER = { success: false, overBudget: true };

describe('boundedSafeParse (review addendum 2, C4)', () => {
  it("returns zod's own result, messages included, while a value stays within its budget", () => {
    const schema = z.object({ a: z.number(), b: z.string() }).strict();
    expect(boundedSafeParse(schema, { a: 1, b: 'x' }, 0)).toEqual({ success: true, data: { a: 1, b: 'x' } });
    const failed = boundedSafeParse(schema, { a: 'x', b: 1 }, 2);
    if (failed.success || 'overBudget' in failed) throw new Error('expected an ordinary failure');
    expect(failed.error.issues).toEqual(schema.safeParse({ a: 'x', b: 1 }).error?.issues);
    expect(failed.error.issues.map((issue) => issue.path.join('.'))).toEqual(['a', 'b']);
  });

  it('stops the walk at the first issue past the budget', () => {
    let visits = 0;
    const schema = z.array(z.custom<number>((value) => { visits += 1; return typeof value === 'number'; }));
    expect(boundedSafeParse(schema, Array.from({ length: 50_000 }, () => 'x'), 10)).toEqual(OVER);
    expect(visits).toBe(11);
    // Control: unbounded, zod visits every element.
    visits = 0;
    expect(schema.safeParse(Array.from({ length: 1000 }, () => 'x')).success).toBe(false);
    expect(visits).toBe(1000);
  });

  it('counts the issues of union options that a passing value makes moot, so each call site budgets for them', () => {
    const schema = z.union([z.array(z.string()), z.array(z.number())]);
    expect(boundedSafeParse(schema, [1, 2, 3], 3).success).toBe(true);
    expect(boundedSafeParse(schema, [1, 2, 3], 2)).toEqual(OVER);
  });

  it('does not count an issue that carries its own message, which is why bounded schemas cap their collections', () => {
    const result = boundedSafeParse(z.array(z.string().refine(() => false, 'refused')).max(100), Array.from({ length: 100 }, () => 'x'), 0);
    if (result.success || 'overBudget' in result) throw new Error('expected an ordinary failure');
    expect(result.error.issues).toHaveLength(100);
  });

  it('rethrows anything else a schema throws, and refuses a budget that is not a whole number', () => {
    const throwing = z.string().refine(() => { throw new RangeError('synthetic'); });
    expect(() => boundedSafeParse(throwing, 'x', 5)).toThrow(RangeError);
    for (const budget of [-1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(() => boundedSafeParse(z.string(), 'x', budget)).toThrow(TypeError);
    }
  });
});

describe('broker input checks stop at their first issue (review addendum 2, C4)', () => {
  const inputs = Object.entries(VAULT_INPUT_SCHEMAS) as [string, z.ZodTypeAny][];

  it('no input schema holds a union that tries its options or a .catch, so no issue is ever moot', () => {
    const moot = inputs.flatMap(([op, schema]) => zodNodes(schema)
      .filter((node) => node.typeName === 'ZodUnion' || node.typeName === 'ZodCatch').map((node) => `${op} ${node.path}`));
    expect(moot).toEqual([]);
  });

  it('every input collection has a maximum and no record holds a refinement, so the issues a budget cannot count stay few', () => {
    const problems: string[] = [];
    for (const [op, schema] of inputs) {
      for (const node of zodNodes(schema)) {
        const def = node.schema._def as Record<string, unknown>;
        if (node.typeName === 'ZodArray' && !def.maxLength && !def.exactLength) problems.push(`${op} ${node.path}: no maximum`);
        if (node.typeName === 'ZodSet' && !def.maxSize) problems.push(`${op} ${node.path}: no maximum`);
        if ((node.typeName === 'ZodRecord' || node.typeName === 'ZodMap')
          && zodNodes(node.schema).some((inner) => inner.typeName === 'ZodEffects')) problems.push(`${op} ${node.path}: refinement in a record`);
      }
    }
    expect(problems).toEqual([]);
  });

  it('stops a vault.imports.commit body of bad rows at the first row (the measured GHSA-mrhx-c7xc-m3w5 case)', () => {
    const schema = VAULT_INPUT_SCHEMAS['vault.imports.commit'];
    const within = trackedObjects(5000);
    expect(boundedSafeParse(schema, { ...validInput('vault.imports.commit'), rows: within.items }, 0)).toEqual(OVER);
    expect(within.touched.size).toBe(1);
    // Past the maximum, the length issue comes first and no row is read.
    const over = trackedObjects(43_000);
    expect(boundedSafeParse(schema, { ...validInput('vault.imports.commit'), rows: over.items }, 0)).toEqual(OVER);
    expect(over.touched.size).toBe(0);
    // Control: unbounded, zod reads every row.
    const control = trackedObjects(5000);
    expect(schema.safeParse({ ...validInput('vault.imports.commit'), rows: control.items }).success).toBe(false);
    expect(control.touched.size).toBe(5000);
  });
});

describe('capture and import payload checks count only real issues (review addendum 2, C4)', () => {
  it('pick one payload schema by item type and hold no union that tries its options or a .catch', () => {
    expect((CapturePayloadSchema._def as { typeName: string }).typeName).toBe('ZodDiscriminatedUnion');
    const moot = zodNodes(CapturePayloadSchema).filter((node) => node.typeName === 'ZodUnion' || node.typeName === 'ZodCatch')
      .map((node) => node.path);
    expect(moot).toEqual([]);
  });
});

describe('every other zod parse in the vault reads a value the vault built or the relay signed (review addendum 2, C4)', () => {
  // A parse of caller data goes through boundedSafeParse. These are the rest, each with the reason it
  // needs no bound. A new site fails this test until it is bounded or listed here with its reason.
  const UNBOUNDED = [
    'actions/approvals.ts VAULT_OUTPUT_SCHEMAS[...].safeParse', // an operation view the broker built
    'actions/common.ts VAULT_OUTPUT_SCHEMAS[...].safeParse', // a stored result the broker wrote
    'bounded-parse.ts schema.safeParse', // the bounded parse itself
    'broker/alerts.ts VaultAlertSchema.safeParse', // an alert the broker raised
    'broker/alerts.ts VaultAlertSchema.safeParse',
    'broker/dispatcher.ts VAULT_OUTPUT_SCHEMAS[...].safeParse', // a handler's answer
    'owner-auth/handlers.ts VaultWebAuthnCreationOptionsSchema.parse', // options the WebAuthn library generated
    'owner-auth/handlers.ts VaultWebAuthnRequestOptionsSchema.parse',
    'relay/alerts.ts HeaderSchema.safeParse', // the relay building the header, then reading the broker's (size-capped)
    'relay/alerts.ts HeaderSchema.safeParse',
    'relay/attestation.ts ClaimsSchema.safeParse', // claims the relay signs, then reads only after the signature checks
    'relay/attestation.ts ClaimsSchema.safeParse',
  ];

  it('lists every unbounded parse site', () => {
    const source = fileURLToPath(new URL('../src/', import.meta.url));
    const sites: string[] = [];
    const scan = (directory: string): void => {
      for (const entry of readdirSync(directory, { withFileTypes: true })) {
        const path = join(directory, entry.name);
        if (entry.isDirectory()) { scan(path); continue; }
        if (!entry.name.endsWith('.ts')) continue;
        for (const match of readFileSync(path, 'utf8').matchAll(/(\w+)(\[[^\]\n]*\])?\.(safeParseAsync|safeParse|parseAsync|parse)\(/g)) {
          const [, receiver, index, method] = match as unknown as [string, string, string | undefined, string];
          // `.parse(` is also JSON, Date and the import parser; a zod schema is named ...Schema(s).
          if (!method.startsWith('safe') && !/Schemas?$|SCHEMAS$/.test(receiver)) continue;
          sites.push(`${relative(source, path)} ${receiver}${index ? '[...]' : ''}.${method}`);
        }
      }
    };
    scan(source);
    expect(sites.sort()).toEqual([...UNBOUNDED].sort());
  });
});
