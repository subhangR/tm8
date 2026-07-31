/**
 * W5 Duo C — minimal schema-valid body generator.
 *
 * WHAT THIS IS FOR. The existing mounting probe (`test/w2/reserved-honesty.test.ts`)
 * sends NO body. That is sound for the question it asks — `server.ts:163-164`
 * looks the handler up BEFORE `:166` validates, so an unmounted operation
 * answers 501 regardless of body. It is unsound for the question this duo asks:
 * a *mounted* operation whose handler throws `not_implemented` is invisible to a
 * no-body probe whenever the operation has an `INPUT_SCHEMAS` entry, because the
 * empty body fails validation at `:166` and returns 400 BEFORE `:182` runs.
 *
 * To see past `:166` we must send a body the schema ACCEPTS. This file builds
 * one by walking the zod schema, not by hand-writing 54 literals.
 *
 * WHAT THIS GENERATOR CAN BE SATISFIED BY, stated because it is the failure that
 * would poison every downstream reading: a body this file emits that the schema
 * REJECTS produces a 400 at `:166`, which is indistinguishable at the wire from
 * "the handler refused the input" unless you look at the code. A 400 in the
 * sweep is therefore an INSTRUMENT FAILURE, never a finding — and that is why
 * `generator-proof.test.ts` gates every emitted body through the very schema it
 * was generated from, in-process, before any request is sent. The sweep is
 * uninterpretable unless that gate is green.
 *
 * It does NOT attempt to produce a body the HANDLER will accept — only one the
 * SCHEMA will. Reaching the handler is the entire mandate; what the handler then
 * says about a nonexistent entity id is a separate, honest answer.
 */
import type { ZodTypeAny } from 'zod';

/**
 * A syntactically valid UUIDv7 that exists in no scratch database. Chosen over a
 * random string because `EntityIdSchema` is only `z.string().min(1)` — the
 * SCHEMA would accept `"x"`, but the DATABASE would answer with a uuid parse
 * error (a 500) instead of the clean `not_found` that proves the handler ran and
 * reasoned. Both prove handler reach; only one of them reads as an answer.
 */
export const ABSENT_ID = '01900000-0000-7000-8000-000000000001';

/** Second distinct id, for shapes needing two non-equal references. */
export const ABSENT_ID_2 = '01900000-0000-7000-8000-000000000002';

export const ISO_TIMESTAMP = '2026-01-01T00:00:00.000Z';

/**
 * Candidate ladder for the shapes introspection cannot read: a `.regex()` whose
 * pattern we do not parse, and `z.custom()` (which is `z.any()` wearing a
 * `superRefine`, so its `_def` says nothing about what it wants).
 *
 * The ladder is only sound because every candidate is CHECKED against the very
 * schema it is offered to before being returned — a guess that is verified is a
 * measurement; a guess that is not is the 400 this whole file exists to avoid.
 */
const CANDIDATES: readonly unknown[] = [
  ABSENT_ID,
  '0'.repeat(64), // lowercase sha-256 hex digest
  'c:w5surface', // the `c:<name>` custom-kind namespace
  'w5surface',
  'text/plain',
  1,
  true,
  {},
  [],
];

interface Ctx {
  /** Object key this value is being generated for; drives the string hints. */
  readonly key: string;
  readonly depth: number;
}

function typeName(schema: ZodTypeAny): string {
  return (schema as { _def?: { typeName?: string } })._def?.typeName ?? 'unknown';
}

function def(schema: ZodTypeAny): Record<string, unknown> {
  return (schema as unknown as { _def: Record<string, unknown> })._def;
}

/**
 * String values are chosen by KEY NAME, not by schema shape, because the
 * contract's `EntityIdSchema` is a bare `z.string().min(1)` and carries no
 * `.uuid()` check to introspect. This is a heuristic and it is stated as one:
 * it is verified per-schema by `safeParse` in `generator-proof.test.ts`, which
 * is what makes a wrong guess a red rather than a silent 400 in the sweep.
 */
function stringFor(key: string, schema: ZodTypeAny): string {
  const checks = (def(schema)['checks'] as Array<{ kind: string; value?: unknown; regex?: RegExp }> | undefined) ?? [];
  for (const check of checks) {
    if (check.kind === 'uuid') return ABSENT_ID;
    if (check.kind === 'email') return 'w5@example.invalid';
    if (check.kind === 'url') return 'https://example.invalid/w5';
    if (check.kind === 'datetime') return ISO_TIMESTAMP;
    if (check.kind === 'regex' && check.regex) return matchRegex(check.regex, key);
  }

  const lower = key.toLowerCase();
  if (lower === 'clientmutationid') return 'w5-surface-sweep-cmid';
  if (lower.endsWith('at') && (lower.includes('expire') || lower.includes('created') || lower.includes('updated'))) {
    return ISO_TIMESTAMP;
  }
  if (lower === 'kind') return 'task';
  if (lower === 'id' || lower.endsWith('id')) return ABSENT_ID;
  if (lower.endsWith('ids')) return ABSENT_ID;

  const min = checks.find((c) => c.kind === 'min')?.value;
  const width = typeof min === 'number' && min > 8 ? min : 8;
  return 'w5surface'.repeat(Math.ceil(width / 9)).slice(0, Math.max(width, 8));
}

/**
 * Only handles the shapes the contract actually uses. An unrecognised regex
 * falls through to the plain hint rather than guessing, and the resulting
 * `safeParse` failure surfaces in `generator-proof.test.ts` as a named red.
 */
function matchRegex(regex: RegExp, key: string): string {
  const source = regex.source;
  if (source.includes('c:')) return 'c:w5surface';
  return stringFor(key, { _def: { checks: [] } } as unknown as ZodTypeAny);
}

export function minimalValue(schema: ZodTypeAny, ctx: Ctx = { key: '', depth: 0 }): unknown {
  if (ctx.depth > 12) return undefined;
  const d = def(schema);

  switch (typeName(schema)) {
    case 'ZodOptional':
    case 'ZodDefault':
    case 'ZodCatch':
      // A required-position optional still needs a value; at OBJECT level the
      // key is omitted entirely (see the ZodObject branch), which is what makes
      // the body minimal.
      return minimalValue(d['innerType'] as ZodTypeAny, ctx);

    case 'ZodNullable': {
      // Prefer the inner value over `null`. `null` passes the schema but is the
      // one input the program has already caught a handler mishandling
      // (`note: null` accepted with a 200 and silently doing nothing) — sending
      // it by default would mix that live defect into a stub sweep.
      const inner = minimalValue(d['innerType'] as ZodTypeAny, ctx);
      return inner === undefined ? null : inner;
    }

    case 'ZodLazy':
      return minimalValue((d['getter'] as () => ZodTypeAny)(), { ...ctx, depth: ctx.depth + 1 });

    case 'ZodEffects': {
      // A `.refine()`/`.superRefine()`/`.transform()` wrapper is opaque to
      // introspection. Generate the inner shape first; if the refinement rejects
      // it, walk the candidate ladder against THIS schema. `z.custom()` lands
      // here as `ZodAny + superRefine`, where the inner walk yields `{}` and the
      // ladder is the only thing that can recover a valid value.
      const inner = minimalValue(d['schema'] as ZodTypeAny, ctx);
      if (schema.safeParse(inner).success) return inner;
      for (const candidate of CANDIDATES) {
        if (schema.safeParse(candidate).success) return candidate;
      }
      return inner;
    }

    case 'ZodBranded':
    case 'ZodReadonly':
      return minimalValue((d['type'] ?? d['innerType']) as ZodTypeAny, ctx);

    case 'ZodPipeline':
      return minimalValue(d['in'] as ZodTypeAny, ctx);

    case 'ZodObject': {
      const shape = (d['shape'] as () => Record<string, ZodTypeAny>)();
      const out: Record<string, unknown> = {};
      for (const [key, field] of Object.entries(shape)) {
        if (isSkippable(field)) continue; // minimal body: omit every optional
        const value = minimalValue(field, { key, depth: ctx.depth + 1 });
        if (value !== undefined) out[key] = value;
      }
      return out;
    }

    case 'ZodArray': {
      const exact = d['exactLength'] as { value: number } | null | undefined;
      const min = (d['minLength'] as { value: number } | null | undefined)?.value ?? exact?.value ?? 0;
      const element = d['type'] as ZodTypeAny;
      return Array.from({ length: min }, () => minimalValue(element, { ...ctx, depth: ctx.depth + 1 }));
    }

    case 'ZodTuple':
      return (d['items'] as ZodTypeAny[]).map((item) =>
        minimalValue(item, { ...ctx, depth: ctx.depth + 1 }));

    case 'ZodRecord':
    case 'ZodMap':
      return {};

    case 'ZodString': {
      const hinted = stringFor(ctx.key, schema);
      if (schema.safeParse(hinted).success) return hinted;
      for (const candidate of CANDIDATES) {
        if (typeof candidate === 'string' && schema.safeParse(candidate).success) return candidate;
      }
      return hinted;
    }

    case 'ZodNumber': {
      const checks = (d['checks'] as Array<{ kind: string; value?: number; inclusive?: boolean }> | undefined) ?? [];
      const isInt = checks.some((c) => c.kind === 'int');
      const minCheck = checks.find((c) => c.kind === 'min');
      const maxCheck = checks.find((c) => c.kind === 'max');
      let value = 1;
      if (minCheck && typeof minCheck.value === 'number') {
        // `.positive()` is an EXCLUSIVE min of 0, not a min of 1. Reading the
        // bound without its `inclusive` flag is what emitted `expectedVersion:
        // 0` against `z.number().int().positive()` on seven operations at once.
        value = minCheck.inclusive === false
          ? minCheck.value + (isInt ? 1 : 1e-6)
          : minCheck.value;
        if (isInt) value = Math.ceil(value);
      }
      if (maxCheck && typeof maxCheck.value === 'number' && value > maxCheck.value) {
        value = maxCheck.inclusive === false ? maxCheck.value - (isInt ? 1 : 1e-6) : maxCheck.value;
      }
      if (schema.safeParse(value).success) return value;
      for (const candidate of [1, 0, -1, 1.5]) {
        if (schema.safeParse(candidate).success) return candidate;
      }
      return value;
    }

    case 'ZodBigInt':
      return 1;
    case 'ZodBoolean':
      return false;
    case 'ZodDate':
      return ISO_TIMESTAMP;
    case 'ZodNull':
      return null;
    case 'ZodUndefined':
    case 'ZodVoid':
      return undefined;
    case 'ZodLiteral':
      return d['value'];
    case 'ZodEnum':
      return (d['values'] as string[])[0];
    case 'ZodNativeEnum':
      return Object.values(d['values'] as Record<string, unknown>)[0];

    case 'ZodUnion': {
      // Try each member and keep the first whose own schema accepts what we
      // built for it. Falling through to member 0 unchecked is how a union
      // silently emits an invalid body.
      const options = d['options'] as ZodTypeAny[];
      for (const option of options) {
        const candidate = minimalValue(option, { ...ctx, depth: ctx.depth + 1 });
        if (option.safeParse(candidate).success) return candidate;
      }
      return minimalValue(options[0]!, { ...ctx, depth: ctx.depth + 1 });
    }

    case 'ZodDiscriminatedUnion': {
      const options = [...(d['options'] as ZodTypeAny[])];
      for (const option of options) {
        const candidate = minimalValue(option, { ...ctx, depth: ctx.depth + 1 });
        if (option.safeParse(candidate).success) return candidate;
      }
      return minimalValue(options[0]!, { ...ctx, depth: ctx.depth + 1 });
    }

    case 'ZodIntersection': {
      const left = minimalValue(d['left'] as ZodTypeAny, ctx);
      const right = minimalValue(d['right'] as ZodTypeAny, ctx);
      if (isPlainObject(left) && isPlainObject(right)) return { ...left, ...right };
      return left;
    }

    case 'ZodAny':
    case 'ZodUnknown':
      return {};

    case 'ZodNever':
      return undefined;

    default:
      return undefined;
  }
}

function isSkippable(field: ZodTypeAny): boolean {
  const name = typeName(field);
  if (name === 'ZodOptional' || name === 'ZodDefault' || name === 'ZodNever') return true;
  if (name === 'ZodEffects') return isSkippable(def(field)['schema'] as ZodTypeAny);
  return false;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Per-operation overrides, each carrying the reason it exists.
 *
 * An entry here is an admission that the generic walk could not satisfy the
 * schema — a refinement, a cross-field constraint, or a semantic the shape does
 * not encode. Every one of them is still gated by `safeParse` in
 * `generator-proof.test.ts`; an override is a different AUTHOR, not a different
 * standard of proof.
 */
export const BODY_OVERRIDES: Readonly<Record<string, unknown>> = {
  /**
   * `PostMessageInputSchema` is a `superRefine` over the wire object requiring
   * EXACTLY ONE of `anchorIds` / the deprecated `anchorId` (schemas.ts:911-913).
   * Both are OPTIONAL in the underlying shape, so the minimal walk correctly
   * omits both — and "neither" is precisely what that refinement rejects. No
   * amount of shape introspection can see a constraint expressed as a
   * cross-field predicate, so this is hand-written, and it is hand-written HERE
   * rather than in the walk so the exception is countable.
   */
  'messages.post': {
    clientMutationId: 'w5-surface-sweep-cmid',
    anchorIds: [ABSENT_ID],
    body: 'w5surface',
  },

  /**
   * `ServerConnectionBaseUrlSchema` superRefines the STRING into a URL and
   * requires a bare origin — no path, query, credentials or fragment. A shape
   * walk can produce "a valid URL string" but cannot see the origin-only
   * predicate, so the candidate it finds carries a path and is rejected.
   */
  'serverConnections.create': {
    clientMutationId: 'w5-surface-sweep-cmid',
    name: 'w5surfac',
    baseUrl: 'https://example.invalid',
  },

  /**
   * `UpdateAttentionRequestInputSchema` refines "at least one of
   * reason/points/status/resolutionNote present" over four OPTIONAL fields —
   * the minimal walk omits all four, which is precisely what it rejects.
   */
  'attentionRequests.update': {
    clientMutationId: 'w5-surface-sweep-cmid',
    expectedVersion: 1,
    reason: 'w5 surface sweep probe',
  },

  /**
   * `ArtifactManifestSchema` requires ≥1 file AND `entrypoint` to be one of
   * the file paths — a cross-field predicate over an array the minimal walk
   * leaves empty. One canonical single-file bundle serves both operations.
   */
  'artifacts.create': {
    clientMutationId: 'w5-surface-sweep-cmid',
    spaceId: '01900000-0000-7000-8000-000000000001',
    name: 'w5surfac',
    manifest: {
      schema: 'tm8.web-artifact/1',
      runtime: 'web-static-v1',
      entrypoint: 'index.html',
      files: [{
        path: 'index.html',
        mediaType: 'text/html',
        size: 0,
        sha256: 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
      }],
    },
  },
  'artifacts.publish': {
    clientMutationId: 'w5-surface-sweep-cmid',
    expectedVersion: 1,
    manifest: {
      schema: 'tm8.web-artifact/1',
      runtime: 'web-static-v1',
      entrypoint: 'index.html',
      files: [{
        path: 'index.html',
        mediaType: 'text/html',
        size: 0,
        sha256: 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
      }],
    },
  },
};

export function bodyFor(opName: string, schema: ZodTypeAny): unknown {
  if (Object.prototype.hasOwnProperty.call(BODY_OVERRIDES, opName)) return BODY_OVERRIDES[opName];
  return minimalValue(schema, { key: '', depth: 0 });
}
