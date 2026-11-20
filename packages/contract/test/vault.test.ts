/**
 * The vault contract (task 01a1fa87, plan doc 01a1fab7 §4).
 *
 * The broker's end-to-end canary tests are the proof of acceptance test 1 ("no
 * operation returns a value"). This file is the cheap guard in front of them.
 * It walks every vault schema and fails when:
 * - an output gains a free-text field whose name says "secret";
 * - an output gains ANY new free-text field nobody reviewed (the inventory below);
 * - any object stops being strict, so the relay can no longer reject smuggled fields;
 * - a step-up input starts transforming values, so a bound assertion could drift.
 */
import { createECDH, createHash, randomBytes, randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import type { ZodTypeAny } from 'zod';
import {
  VAULT_ERROR_REASONS,
  VAULT_INPUT_SCHEMAS,
  VAULT_OPERATIONS,
  VAULT_OUTPUT_SCHEMAS,
  VAULT_STEP_UP_ACTIONS,
  VaultApprovalDecideInputSchema,
  VaultCaptureLinkCreateInputSchema,
  VaultCapturePublicKeySchema,
  VaultItemViewSchema,
  VaultPasskeyRegisterBeginInputSchema,
  VaultSealedEnvelopeSchema,
  VaultStepUpProofSchema,
  vaultStepUpBoundParams,
} from '../src/index.js';

interface Def {
  typeName?: string;
  [key: string]: unknown;
}
const defOf = (schema: ZodTypeAny): Def => schema._def as Def;

type Visit = (node: ZodTypeAny, path: string, key: string | null) => void;

/** Visits every node: wrappers first, then what they wrap, with the key of the nearest object property. */
function walk(schema: ZodTypeAny, visit: Visit, path = '', key: string | null = null, depth = 0): void {
  if (depth > 40) throw new Error(`schema nested too deep at ${path}`);
  visit(schema, path, key);
  const def = defOf(schema);
  const next = (child: unknown, childPath: string, childKey: string | null) =>
    walk(child as ZodTypeAny, visit, childPath, childKey, depth + 1);
  switch (def.typeName) {
    case 'ZodObject':
      for (const [childKey, child] of Object.entries((schema as unknown as { shape: Record<string, ZodTypeAny> }).shape)) {
        next(child, `${path}.${childKey}`, childKey);
      }
      return;
    case 'ZodArray':
      return next(def.type, `${path}[]`, key);
    case 'ZodOptional':
    case 'ZodNullable':
    case 'ZodDefault':
    case 'ZodCatch':
      return next(def.innerType, path, key);
    case 'ZodEffects':
      return next(def.schema, path, key);
    case 'ZodUnion':
    case 'ZodDiscriminatedUnion':
      (def.options as ZodTypeAny[]).forEach((option, index) => next(option, `${path}|${index}`, key));
      return;
    case 'ZodRecord':
      return next(def.valueType, `${path}{}`, key);
    case 'ZodPipeline':
      next(def.in, path, key);
      return next(def.out, path, key);
    case 'ZodLazy':
      throw new Error(`lazy schema at ${path}: walk it explicitly`);
    default:
      return;
  }
}

/** A leaf that can carry arbitrary text. UUIDs and timestamps cannot carry a meaningful secret, so they do not count. */
function isFreeText(node: ZodTypeAny): boolean {
  const def = defOf(node);
  if (def.typeName === 'ZodUnknown' || def.typeName === 'ZodAny') return true;
  if (def.typeName !== 'ZodString') return false;
  const checks = (def.checks as { kind: string }[]) ?? [];
  return !checks.some((check) => check.kind === 'uuid' || check.kind === 'datetime');
}

const OP_NAMES = VAULT_OPERATIONS.map((op) => op.name);
const STEP_UP_OPS: readonly string[] = VAULT_STEP_UP_ACTIONS;

/** Object keys whose name means "a secret". A free-text leaf under one of these fails, unless allowlisted below. */
const DENIED_KEYS = new Set([
  'password', 'passwd', 'passphrase', 'secret', 'secrets', 'pan', 'cardnumber', 'cvv', 'cvc', 'totp', 'otp', 'seed',
  'notes', 'note', 'plaintext', 'key', 'apikey', 'privatekey', 'token', 'accesstoken', 'refreshtoken', 'linktoken',
  'sessiontoken', 'cookie', 'cookies', 'authorization', 'value', 'body', 'fields', 'codes', 'code', 'd',
]);
const normalizeKey = (key: string) => key.toLowerCase().replace(/[_-]/g, '');

/**
 * The deliberate exceptions, each with its reason:
 * - recovery codes are shown exactly once, by design (MSG 9);
 * - an API response body is the upstream reply after the key, canaries and
 *   credential-shaped spans were filtered out (MSG 5). It is not a vault value.
 */
function deniedKeyAllowed(op: string, path: string, key: string): boolean {
  if (op === 'vault.recovery.codes.create' && key === 'codes') return true;
  if ((op === 'vault.callApi' || op === 'vault.operations.get') && key === 'value' && path.includes('.response.body')) return true;
  return false;
}

/**
 * EVERY free-text field name in a vault OUTPUT, reviewed by hand. When this
 * test fails because you added a field, check that it can never hold a secret
 * value, then add its name here in the same commit. The security review reads
 * this list.
 */
const REVIEWED_OUTPUT_TEXT_FIELDS = [
  // Item metadata (R1): names, usernames, last 4, bound origins and hosts.
  'name', 'username', 'last4', 'connector', 'origins', 'hosts', 'fieldNames', 'itemName', 'itemSummary', 'merchant',
  'currency', 'deviceLabel', 'transports', 'warnings', 'reason', 'originError', 'origin', 'finalOrigin', 'observedOrigin',
  'similarTo', 'purpose', 'pathPrefixes', 'prefix', 'kind',
  // Audit params and approval bound params are metadata only; the broker's per-action param schemas enforce it.
  'params', 'boundParams',
  // Hashes, cursors and processor references.
  'intentHash', 'prevHash', 'entryHash', 'headHash', 'nextCursor', 'processorRef',
  // Allowlisted upstream response headers and the filtered response body (see deniedKeyAllowed).
  'headers', 'value',
  // The masked fill screenshot (WS-C masks every form control and any element showing a filled value).
  'dataBase64',
  // Capture public key and WebAuthn options: public values only. `extensions` holds the WebAuthn extension INPUTS the broker sets (e.g. credProps).
  'kid', 'x', 'y', 'raw', 'challenge', 'rpId', 'id', 'displayName', 'extensions',
  // The capture link (its fragment token grants nothing without the owner's passkey).
  'url',
  // Recovery codes: the one deliberate exception (MSG 9).
  'codes',
].sort();

describe('the vault operation table', () => {
  it('has 40 reserved operations, uniquely named and mounted under /v2/vault', () => {
    expect(VAULT_OPERATIONS).toHaveLength(40);
    expect(new Set(OP_NAMES).size).toBe(OP_NAMES.length);
    const mounts = VAULT_OPERATIONS.map((op) => `${op.method} ${op.path}`);
    expect(new Set(mounts).size).toBe(mounts.length);
    for (const op of VAULT_OPERATIONS) {
      expect(op.name.startsWith('vault.')).toBe(true);
      expect(op.path.startsWith('/v2/vault/')).toBe(true);
      expect(op.status).toBe('reserved');
      expect(op.method === 'GET').toBe(op.kind === 'read');
    }
  });

  it('has no reveal, export or decrypt door (R1)', () => {
    for (const name of OP_NAMES) expect(name).not.toMatch(/reveal|export|decrypt|plaintext|secret|value|copy|show/i);
  });

  it('puts every non-member door behind a human session', () => {
    for (const op of VAULT_OPERATIONS) {
      const humanOnly = 'humanOnly' in op && op.humanOnly === true;
      expect([op.name, humanOnly]).toEqual([op.name, op.authority !== 'member']);
    }
  });

  it('needs a step-up for every owner_step_up door, and every step-up action takes a proof', () => {
    for (const op of VAULT_OPERATIONS) {
      if (op.authority === 'owner_step_up') expect(STEP_UP_OPS).toContain(op.name);
    }
    for (const action of VAULT_STEP_UP_ACTIONS) {
      expect(OP_NAMES).toContain(action);
      let schema: ZodTypeAny = VAULT_INPUT_SCHEMAS[action];
      while (defOf(schema).typeName === 'ZodEffects') schema = defOf(schema).schema as ZodTypeAny;
      const shape = (schema as unknown as { shape: Record<string, ZodTypeAny> }).shape;
      expect([action, Object.keys(shape)]).toEqual([action, expect.arrayContaining(['stepUp'])]);
    }
  });

  it('maps every operation to exactly one input and one output schema', () => {
    expect(Object.keys(VAULT_INPUT_SCHEMAS).sort()).toEqual([...OP_NAMES].sort());
    expect(Object.keys(VAULT_OUTPUT_SCHEMAS).sort()).toEqual([...OP_NAMES].sort());
  });

  it('never repeats a path parameter in the body', () => {
    for (const op of VAULT_OPERATIONS) {
      const params = [...op.path.matchAll(/:([A-Za-z]+)/g)].map((match) => match[1]);
      walk(VAULT_INPUT_SCHEMAS[op.name], (_node, path, key) => {
        if (key !== null && path.split('.').length === 2) expect([op.name, params.includes(key)]).toEqual([op.name, false]);
      });
    }
  });
});

describe('vault outputs carry no secret value (acceptance test 1, contract half)', () => {
  it('has no free-text field under a secret-sounding name, outside the two reviewed exceptions', () => {
    const violations: string[] = [];
    for (const op of OP_NAMES) {
      walk(VAULT_OUTPUT_SCHEMAS[op], (node, path, key) => {
        if (key === null || !isFreeText(node) || !DENIED_KEYS.has(normalizeKey(key))) return;
        if (!deniedKeyAllowed(op, path, key)) violations.push(`${op}${path}`);
      });
    }
    expect(violations).toEqual([]);
  });

  it('has no free-text output field that is missing from the reviewed inventory', () => {
    const seen = new Set<string>();
    for (const op of OP_NAMES) {
      walk(VAULT_OUTPUT_SCHEMAS[op], (node, _path, key) => {
        if (key !== null && isFreeText(node)) seen.add(key);
      });
    }
    expect([...seen].sort()).toEqual(REVIEWED_OUTPUT_TEXT_FIELDS);
  });

  it('rejects a smuggled field: every output object is strict', () => {
    const loose: string[] = [];
    for (const op of OP_NAMES) {
      walk(VAULT_OUTPUT_SCHEMAS[op], (node, path) => {
        if (defOf(node).typeName === 'ZodObject' && defOf(node).unknownKeys !== 'strict') loose.push(`${op}${path}`);
      });
    }
    expect(loose).toEqual([]);
  });

  it('refuses an item view that carries a password', () => {
    const now = new Date().toISOString();
    const item = {
      id: randomUUID(), version: 1, type: 'login', name: 'GitHub', ownerMemberId: randomUUID(), access: 'owner', sharedBy: null,
      state: 'active', exposureTier: null, origins: ['https://github.com'], devMode: false, username: 'octo', last4: null,
      expMonth: null, expYear: null, connector: null, hasTotp: false, hasNotes: false, fieldNames: [], secretVersion: 1,
      createdAt: now, updatedAt: now, rotatedAt: null,
    };
    expect(VaultItemViewSchema.safeParse(item).success).toBe(true);
    expect(VaultItemViewSchema.safeParse({ ...item, password: 'x' }).success).toBe(false);
  });
});

describe('vault inputs', () => {
  it('are strict everywhere', () => {
    const loose: string[] = [];
    for (const op of OP_NAMES) {
      walk(VAULT_INPUT_SCHEMAS[op], (node, path) => {
        if (defOf(node).typeName === 'ZodObject' && defOf(node).unknownKeys !== 'strict') loose.push(`${op}${path}`);
      });
    }
    expect(loose).toEqual([]);
  });

  it('never transform a value in a step-up action, so a bound assertion cannot drift', () => {
    const transforming: string[] = [];
    for (const action of VAULT_STEP_UP_ACTIONS) {
      walk(VAULT_INPUT_SCHEMAS[action], (node, path) => {
        const def = defOf(node);
        const effect = def.effect as { type?: string } | undefined;
        if (def.typeName === 'ZodEffects' && effect?.type !== 'refinement') transforming.push(`${action}${path}: ${effect?.type}`);
        if (def.typeName === 'ZodDefault' || def.typeName === 'ZodCatch' || def.typeName === 'ZodPipeline') transforming.push(`${action}${path}: ${def.typeName}`);
        if (def.coerce === true) transforming.push(`${action}${path}: coerce`);
        const checks = (def.checks as { kind: string }[] | undefined) ?? [];
        for (const check of checks) {
          if (['trim', 'toLowerCase', 'toUpperCase'].includes(check.kind)) transforming.push(`${action}${path}: ${check.kind}`);
        }
      });
    }
    expect(transforming).toEqual([]);
  });

  it('refuse surrounding whitespace in a step-up label rather than trimming it', () => {
    const base = { clientMutationId: 'm1', enrollmentCode: 'abcd-efgh-1234' };
    expect(VaultPasskeyRegisterBeginInputSchema.safeParse({ ...base, name: 'Laptop' }).success).toBe(true);
    expect(VaultPasskeyRegisterBeginInputSchema.safeParse({ ...base, name: ' Laptop' }).success).toBe(false);
  });

  it('take exactly one passkey-registration authorization', () => {
    const base = { clientMutationId: 'm1', name: 'Phone' };
    expect(VaultPasskeyRegisterBeginInputSchema.safeParse(base).success).toBe(false);
    expect(VaultPasskeyRegisterBeginInputSchema.safeParse({ ...base, recoveryCode: 'abcd-efgh-1234' }).success).toBe(true);
    expect(
      VaultPasskeyRegisterBeginInputSchema.safeParse({ ...base, recoveryCode: 'abcd-efgh-1234', enrollmentCode: 'abcd-efgh-1234' }).success,
    ).toBe(false);
  });

  it('need a step-up to approve, but not to deny', () => {
    const base = { clientMutationId: 'm1', approvalIntentHash: 'a'.repeat(64) };
    expect(VaultApprovalDecideInputSchema.safeParse({ ...base, decision: 'deny' }).success).toBe(true);
    expect(VaultApprovalDecideInputSchema.safeParse({ ...base, decision: 'approve' }).success).toBe(false);
    const stepUp = {
      challengeId: randomUUID(),
      assertion: {
        id: 'cred', rawId: 'cred', type: 'public-key', clientExtensionResults: {},
        response: { clientDataJSON: 'e30', authenticatorData: 'AAAA', signature: 'AAAA' },
      },
    };
    expect(VaultStepUpProofSchema.safeParse(stepUp).success).toBe(true);
    expect(VaultApprovalDecideInputSchema.safeParse({ ...base, decision: 'approve', stepUp }).success).toBe(true);
  });

  it('tie itemId to replace-captures only', () => {
    const base = { clientMutationId: 'm1', itemType: 'login' };
    expect(VaultCaptureLinkCreateInputSchema.safeParse({ ...base, purpose: 'create' }).success).toBe(true);
    expect(VaultCaptureLinkCreateInputSchema.safeParse({ ...base, purpose: 'replace' }).success).toBe(false);
    expect(VaultCaptureLinkCreateInputSchema.safeParse({ ...base, purpose: 'create', itemId: randomUUID() }).success).toBe(false);
    expect(VaultCaptureLinkCreateInputSchema.safeParse({ ...base, purpose: 'replace', itemId: randomUUID() }).success).toBe(true);
  });

  it('refuse an actorId or workSessionId in every vault body (no acting as someone else)', () => {
    const found: string[] = [];
    for (const op of OP_NAMES) {
      walk(VAULT_INPUT_SCHEMAS[op], (_node, path, key) => {
        if (key === 'actorId' || key === 'workSessionId') found.push(`${op}${path}`);
      });
    }
    expect(found).toEqual([]);
  });
});

describe('the capture envelope matches packages/vault capture/seal.ts byte lengths', () => {
  it('accepts a real P-256 capture public key and refuses one that carries a private scalar', () => {
    const ecdh = createECDH('prime256v1');
    ecdh.generateKeys();
    const point = ecdh.getPublicKey();
    const key = {
      kid: createHash('sha256').update(point).digest('hex').slice(0, 32),
      raw: point.toString('base64url'),
      jwk: { kty: 'EC', crv: 'P-256', x: point.subarray(1, 33).toString('base64url'), y: point.subarray(33, 65).toString('base64url'), ext: true },
    };
    expect(VaultCapturePublicKeySchema.safeParse(key).success).toBe(true);
    const withPrivate = { ...key, jwk: { ...key.jwk, d: ecdh.getPrivateKey().toString('base64url') } };
    expect(VaultCapturePublicKeySchema.safeParse(withPrivate).success).toBe(false);
  });

  it('accepts the smallest well-formed envelope and refuses a short ephemeral key', () => {
    const epk = Buffer.concat([Buffer.from([4]), randomBytes(64)]).toString('base64url');
    const envelope = { v: 1, kid: 'a'.repeat(32), epk, nonce: randomBytes(12).toString('base64url'), ct: randomBytes(17).toString('base64url') };
    expect(VaultSealedEnvelopeSchema.safeParse(envelope).success).toBe(true);
    expect(VaultSealedEnvelopeSchema.safeParse({ ...envelope, epk: epk.slice(0, 86) }).success).toBe(false);
    expect(VaultSealedEnvelopeSchema.safeParse({ ...envelope, ct: randomBytes(16).toString('base64url') }).success).toBe(false);
  });
});

describe('vaultStepUpBoundParams', () => {
  it('drops the proof and the mutation id, and namespaces path params', () => {
    const bound = vaultStepUpBoundParams(
      { itemId: 'i-1' },
      { clientMutationId: 'm1', stepUp: { challengeId: 'c' }, expectedVersion: 3, devMode: true, skipped: undefined },
    );
    expect(bound).toEqual({ expectedVersion: 3, devMode: true, 'path.itemId': 'i-1' });
  });

  it('refuses a body key that would shadow a path parameter', () => {
    expect(() => vaultStepUpBoundParams({ itemId: 'i-1' }, { 'path.itemId': 'i-2' })).toThrow(TypeError);
  });
});

describe('error reasons', () => {
  it('are unique and include the v1 spend-off reason', () => {
    expect(new Set(VAULT_ERROR_REASONS).size).toBe(VAULT_ERROR_REASONS.length);
    expect(VAULT_ERROR_REASONS).toContain('spend_disabled');
    expect(VAULT_ERROR_REASONS).toContain('value_request_refused');
  });
});
