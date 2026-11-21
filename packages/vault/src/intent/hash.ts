import { createHash } from 'node:crypto';

/**
 * Canonical JSON (RFC 8785 JCS subset) and the approval intent hash
 * (brief MSG 11: "intent_hash is re-verified at execution").
 *
 * An approval binds `intent_hash = SHA-256("tm8-vault-intent|v1|" + kind + "|" + JCS(bound_params))`.
 * The WebAuthn challenge the owner signs is derived from the same hash, so the
 * owner's signature covers exactly these parameters. At execution the broker
 * recomputes the hash from the parameters it is about to act on. A mismatch
 * refuses the operation. It never "updates" the approval.
 *
 * Inputs are restricted to JSON-safe values: no undefined, functions, symbols,
 * bigint, non-finite numbers, Dates or class instances. Anything else throws,
 * because silently dropping a field would let two different intents share a hash.
 */
export class CanonicalJsonError extends Error {
  constructor(path: string, reason: string) {
    super(`canonical JSON refused at ${path || '<root>'}: ${reason}`);
    this.name = 'CanonicalJsonError';
  }
}

const LONE_SURROGATE = /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/;

function encode(value: unknown, path: string, depth: number): string {
  if (depth > 32) throw new CanonicalJsonError(path, 'nesting deeper than 32');
  if (value === null) return 'null';
  switch (typeof value) {
    case 'boolean':
      return value ? 'true' : 'false';
    case 'number':
      if (!Number.isFinite(value)) throw new CanonicalJsonError(path, 'non-finite number');
      return JSON.stringify(Object.is(value, -0) ? 0 : value);
    case 'string':
      if (LONE_SURROGATE.test(value)) throw new CanonicalJsonError(path, 'lone surrogate');
      return JSON.stringify(value);
    case 'object': {
      if (Array.isArray(value)) {
        return `[${value.map((item, index) => encode(item, `${path}[${index}]`, depth + 1)).join(',')}]`;
      }
      const proto = Object.getPrototypeOf(value);
      if (proto !== Object.prototype && proto !== null) throw new CanonicalJsonError(path, 'not a plain object');
      const record = value as Record<string, unknown>;
      const keys = Object.keys(record).sort();
      return `{${keys
        .map((key) => {
          const child = record[key];
          if (child === undefined) throw new CanonicalJsonError(`${path}.${key}`, 'undefined value');
          return `${JSON.stringify(key)}:${encode(child, `${path}.${key}`, depth + 1)}`;
        })
        .join(',')}}`;
    }
    default:
      throw new CanonicalJsonError(path, `unsupported type ${typeof value}`);
  }
}

export function canonicalJson(value: unknown): string {
  return encode(value, '', 0);
}

export const APPROVAL_KINDS = ['new_origin', 'grant', 'spend', 'property_change', 'use'] as const;
export type ApprovalKind = (typeof APPROVAL_KINDS)[number];

export function intentHash(kind: ApprovalKind, boundParams: Record<string, unknown>): string {
  if (!APPROVAL_KINDS.includes(kind)) throw new CanonicalJsonError('kind', 'unknown approval kind');
  return createHash('sha256').update(`tm8-vault-intent|v1|${kind}|${canonicalJson(boundParams)}`, 'utf8').digest('hex');
}

/** Constant-time comparison of two hex digests of equal length. */
export function digestEquals(a: string, b: string): boolean {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}
