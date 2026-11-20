import { z } from 'zod';
import { canonicalJson } from '../intent/hash.js';
import { normalizeOrigin, OriginRefusal } from '../origin/normalize.js';
import { SecretMaterial } from '../secret-material.js';

/**
 * What the owner's browser seals at capture time (brief MSG 6), and how the
 * broker splits it into plaintext METADATA (R1: name, username, last-4, dates)
 * and the SECRET part that is envelope-encrypted.
 *
 * R9: a card never carries a CVV. Any key that looks like one, at any depth,
 * fails with `cvv_refused` BEFORE schema validation. The refusal therefore
 * names the rule rather than an "unknown key", and no CVV value reaches a
 * schema error.
 */
export const VAULT_ITEM_TYPES = ['login', 'api_key', 'card', 'note', 'identity'] as const;
export type VaultItemType = (typeof VAULT_ITEM_TYPES)[number];

const name = z.string().trim().min(1).max(200);

export const LoginPayloadSchema = z
  .object({
    type: z.literal('login'),
    name,
    origin: z.string().min(1).max(2048),
    username: z.string().max(512).optional(),
    password: z.string().min(1).max(4096),
    /** otpauth:// URI or a base32 secret. TOTP autofill itself is v2 (MSG 15). */
    totp: z.string().max(2048).optional(),
    devMode: z.boolean().optional(),
  })
  .strict();

export const ApiKeyPayloadSchema = z
  .object({
    type: z.literal('api_key'),
    name,
    key: z.string().min(8).max(16384),
    /** Connector template id (e.g. `github`); absent = generic mode, labelled weaker. */
    connector: z.string().regex(/^[a-z][a-z0-9_-]{0,63}$/).optional(),
  })
  .strict();

function luhnValid(digits: string): boolean {
  let sum = 0;
  let double = false;
  for (let i = digits.length - 1; i >= 0; i -= 1) {
    let d = digits.charCodeAt(i) - 48;
    if (double) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
    double = !double;
  }
  return sum % 10 === 0;
}

export const CardPayloadSchema = z
  .object({
    type: z.literal('card'),
    name,
    cardholder: z.string().max(200).optional(),
    pan: z
      .string()
      .transform((value) => value.replace(/[\s-]/g, ''))
      .refine((value) => /^[0-9]{12,19}$/.test(value) && luhnValid(value), 'invalid card number'),
    expMonth: z.number().int().min(1).max(12),
    expYear: z.number().int().min(2000).max(2100),
  })
  .strict();

export const NotePayloadSchema = z
  .object({ type: z.literal('note'), name, body: z.string().min(1).max(65536) })
  .strict();

export const IdentityPayloadSchema = z
  .object({
    type: z.literal('identity'),
    name,
    fields: z
      .record(z.string().regex(/^[A-Za-z][A-Za-z0-9 _.-]{0,63}$/), z.string().max(4096))
      .refine((fields) => Object.keys(fields).length >= 1 && Object.keys(fields).length <= 50, '1..50 fields'),
  })
  .strict();

export const CapturePayloadSchema = z.discriminatedUnion('type', [
  LoginPayloadSchema,
  ApiKeyPayloadSchema,
  CardPayloadSchema,
  NotePayloadSchema,
  IdentityPayloadSchema,
]);
export type CapturePayload = z.infer<typeof CapturePayloadSchema>;

export class CapturePayloadError extends Error {
  constructor(
    readonly code: 'cvv_refused' | 'invalid_payload' | 'origin_refused' | 'type_mismatch',
    readonly detail: string,
  ) {
    super(`capture payload refused: ${code}`);
    this.name = 'CapturePayloadError';
  }
}

const CVV_KEY = /^(cvv2?|cvc2?|csc|cid|cav2|cvn|card_?verification(_?(value|code))?|security_?code|securitycode)$/i;

function findCvvKey(value: unknown, depth = 0): boolean {
  if (depth > 8 || value === null || typeof value !== 'object') return false;
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    if (CVV_KEY.test(key.replace(/[\s-]/g, '_'))) return true;
    if (findCvvKey(child, depth + 1)) return true;
  }
  return false;
}

/** Plaintext metadata stored next to the ciphertext. Never contains a secret value. */
export interface ItemMetadata {
  type: VaultItemType;
  name: string;
  /** Normalized exact origin for logins. */
  origin?: string;
  devMode?: boolean;
  username?: string;
  /** Cards: last 4 PAN digits. API keys: last 4 characters when the key is at least 20 long. */
  last4?: string;
  expMonth?: number;
  expYear?: number;
  connector?: string;
  hasTotp?: boolean;
  /** Identity items: field NAMES only. */
  fieldNames?: string[];
}

export interface ParsedCapture {
  metadata: ItemMetadata;
  /** Canonical JSON of the secret fields only, ready for `encryptSecretVersion`. The caller disposes it. */
  secret: SecretMaterial;
}

/**
 * Validates decrypted capture bytes and splits them. `expectedType` comes from
 * the capture link, so an envelope cannot change the item type its link was
 * issued for.
 */
export function parseCapturePayload(plaintext: Buffer, expectedType: VaultItemType): ParsedCapture {
  let raw: unknown;
  try {
    raw = JSON.parse(plaintext.toString('utf8'));
  } catch {
    throw new CapturePayloadError('invalid_payload', 'not JSON');
  }
  if (findCvvKey(raw)) throw new CapturePayloadError('cvv_refused', 'card verification values are never stored (R9)');
  const result = CapturePayloadSchema.safeParse(raw);
  if (!result.success) {
    // Report paths and codes only; zod messages can echo input values.
    const issues = result.error.issues.map((issue) => `${issue.path.join('.') || '<root>'}:${issue.code}`).join(',');
    throw new CapturePayloadError('invalid_payload', issues);
  }
  const payload = result.data;
  if (payload.type !== expectedType) throw new CapturePayloadError('type_mismatch', `link is for ${expectedType}`);

  switch (payload.type) {
    case 'login': {
      let origin: string;
      try {
        origin = normalizeOrigin(payload.origin, { devMode: payload.devMode === true }).origin;
      } catch (error) {
        throw new CapturePayloadError('origin_refused', error instanceof OriginRefusal ? error.code : 'invalid_url');
      }
      return {
        metadata: {
          type: 'login',
          name: payload.name,
          origin,
          ...(payload.devMode ? { devMode: true } : {}),
          ...(payload.username !== undefined ? { username: payload.username } : {}),
          hasTotp: payload.totp !== undefined,
        },
        secret: SecretMaterial.fromUtf8(canonicalJson({ password: payload.password, ...(payload.totp !== undefined ? { totp: payload.totp } : {}) })),
      };
    }
    case 'api_key':
      return {
        metadata: {
          type: 'api_key',
          name: payload.name,
          ...(payload.connector !== undefined ? { connector: payload.connector } : {}),
          ...(payload.key.length >= 20 ? { last4: payload.key.slice(-4) } : {}),
        },
        secret: SecretMaterial.fromUtf8(canonicalJson({ key: payload.key })),
      };
    case 'card':
      return {
        metadata: { type: 'card', name: payload.name, last4: payload.pan.slice(-4), expMonth: payload.expMonth, expYear: payload.expYear },
        secret: SecretMaterial.fromUtf8(
          canonicalJson({ pan: payload.pan, expMonth: payload.expMonth, expYear: payload.expYear, ...(payload.cardholder !== undefined ? { cardholder: payload.cardholder } : {}) }),
        ),
      };
    case 'note':
      return { metadata: { type: 'note', name: payload.name }, secret: SecretMaterial.fromUtf8(canonicalJson({ body: payload.body })) };
    case 'identity':
      return {
        metadata: { type: 'identity', name: payload.name, fieldNames: Object.keys(payload.fields).sort() },
        secret: SecretMaterial.fromUtf8(canonicalJson({ fields: payload.fields })),
      };
  }
}
