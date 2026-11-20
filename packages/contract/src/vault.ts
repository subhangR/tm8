/**
 * The tm8 Secure Vault contract (`vault.*`). Task 01a1fa87, plan doc 01a1fab7 §4.
 *
 * WHAT THIS FILE PROMISES
 *
 * 1. NO OPERATION RETURNS A SECRET VALUE (R1, acceptance test 1). No output
 *    schema below has a field that can hold a password, key, PAN, TOTP seed,
 *    note body or identity field value. There is no reveal operation and there
 *    never will be in v1. A request that asks for a value is refused with
 *    `value_request_refused`, and the refusal is audited as suspicious
 *    (failure case 8). The one output that carries a credential is
 *    `vault.recovery.codes.create`: recovery codes are shown exactly once, by
 *    design (MSG 9).
 *
 * 2. OWNER AUTHORITY IS A PASSKEY, NOT A tm8 SESSION. On this host an agent
 *    acts as its launching member, so every tm8 session credential is treated
 *    as agent-forgeable. `authority` says what each door needs:
 *      - `member`: any tm8 session of the member, human or agent. Agents use
 *        items only through the broker and never see a value.
 *      - `human`: a human tm8 session. These are the passkey ceremonies that
 *        CREATE a vault session (sign-in, registration).
 *      - `owner_session`: a human tm8 session PLUS a vault session, which is an
 *        HttpOnly cookie minted by `vault.session.begin` from a WebAuthn
 *        user-verified assertion. It lasts 15 minutes and refreshes with
 *        rotation.
 *      - `owner_step_up`: `owner_session` PLUS a fresh step-up proof in the
 *        body. The proof is a WebAuthn assertion whose challenge is bound to
 *        the exact parameters of THIS call (`vaultStepUpBoundParams`).
 *    Every non-`member` row is also `humanOnly` at the door (defence in depth).
 *    The broker re-checks everything. The relay only forwards.
 *
 * 3. TOKENS NEVER APPEAR IN A BODY. The vault session and refresh tokens are
 *    `HttpOnly; Secure; SameSite=Strict; Path=/v2/vault` cookies. The capture
 *    link token travels in the URL FRAGMENT and is posted in a body, so it is
 *    never in a server log, a query string or a Referer.
 *
 * 4. ERRORS DO NOT LEAK EXISTENCE (acceptance test 19). An id that belongs to
 *    another member, or that the caller has no grant for, answers `not_found`,
 *    exactly as a missing id does. Vault-specific causes travel as
 *    `error.details.reason` from `VAULT_ERROR_REASONS`.
 *
 * 5. BROKER OUTCOMES ARE RECORDS, NOT ERRORS. `vault.fill`, `vault.callApi`
 *    and `vault.spend.execute` take a caller-supplied `operationId` (MSG 11). A
 *    policy refusal is a 200 with `state: 'refused'` and a code, and is stored
 *    against the operation. Retrying the same `operationId` returns the stored
 *    outcome. The same id with different parameters is a `conflict` with
 *    reason `operation_id_reused`. A call that could not run at all (vault
 *    off, broker down, audit down) is an error, and nothing is recorded.
 *
 * 6. STEP-UP BINDING CANNOT DRIFT. A step-up action's input schema never
 *    transforms a value (no trim, coerce, default or transform), so the body
 *    the broker validates is byte-for-byte the body the owner's assertion was
 *    bound to. A contract test walks those schemas and enforces it.
 *
 * 7. RATE LIMITS AND CSRF (security standard RULE 7). The broker rate-limits
 *    `vault.webauthn.challenge`, `vault.session.begin`, `vault.session.refresh`,
 *    both passkey registration steps and `vault.captures.open`, per member and
 *    per IP, and answers 429 `rate_limited`. Cookie-authenticated vault doors
 *    also require a same-origin `Origin` header on top of SameSite=Strict.
 *
 * These rows are NOT yet in `OPERATIONS` (catalog.ts). They join the catalog in
 * one pass at integration, together with CLI rows and conformance pins.
 */
import { z } from 'zod';

const Id = z.string().uuid();
const Iso = z.string().datetime({ offset: true });
const B64Url = z.string().regex(/^[A-Za-z0-9_-]*$/, 'base64url');
const Hex64 = z.string().regex(/^[0-9a-f]{64}$/, 'a SHA-256 hex digest');
const Cursor = z.string().min(1).max(512);
const Limit = z.coerce.number().int().min(1).max(200);
const Command = { clientMutationId: z.string().min(1).max(128) };
/** Why an agent or person is doing this. It is audited and shown to the owner, and must never contain a secret. */
const Purpose = z.string().trim().min(1).max(500);
const OriginInput = z.string().min(1).max(2048);
/** A label in a STEP-UP input. It rejects surrounding whitespace rather than trimming it, because a step-up body must parse unchanged (point 6). */
const StepUpLabel = (max: number) => z.string().min(1).max(max).regex(/^\S(?:[\s\S]*\S)?$/, 'no leading or trailing whitespace');

// ---------------------------------------------------------------------------
// Constants shared by the broker, the relay and the UI
// ---------------------------------------------------------------------------

export const VAULT_BASE_PATH = '/v2/vault';
/** The standalone capture page (not the SPA). The link is `<origin>/vault/capture/<captureId>#t=<linkToken>`. */
export const VAULT_CAPTURE_PAGE_PATH = '/vault/capture/';
/**
 * The import page: the same standalone page, in import mode. The plaintext export
 * file is read and sealed there, never in the SPA. It needs no link token: every
 * import operation already requires the owner's vault session.
 */
export const VAULT_IMPORT_PAGE_PATH = '/vault/capture/import';
export const VAULT_SESSION_COOKIE = 'tm8_vault_session';
export const VAULT_REFRESH_COOKIE = 'tm8_vault_refresh';
export const VAULT_CAPTURE_LINK_TTL_SECONDS = 600;
export const VAULT_SESSION_TTL_SECONDS = 900;
/** Absolute cap on a refresh family. After this, sign in with a passkey again. */
export const VAULT_REFRESH_FAMILY_TTL_SECONDS = 12 * 3600;
export const VAULT_STEP_UP_CHALLENGE_TTL_SECONDS = 120;
export const VAULT_APPROVAL_DEFAULT_TTL_SECONDS = 900;
/** MSG 8: a revoked grant stops the next operation within this bound. */
export const VAULT_REVOCATION_BOUND_SECONDS = 5;
export const VAULT_MAX_SCREENSHOT_BASE64 = 4 * 1024 * 1024;
export const VAULT_MAX_CAPTURE_CIPHERTEXT = 64 * 1024;
export const VAULT_MAX_IMPORT_CIPHERTEXT = 8 * 1024 * 1024;

export const VAULT_MODES = ['off', 'dev', 'pre_review', 'production'] as const;
export const VaultModeSchema = z.enum(VAULT_MODES);
export type VaultMode = z.infer<typeof VaultModeSchema>;

export const VAULT_ITEM_TYPES = ['login', 'api_key', 'card', 'note', 'identity'] as const;
export const VaultItemTypeSchema = z.enum(VAULT_ITEM_TYPES);
export type VaultItemType = z.infer<typeof VaultItemTypeSchema>;

export const VAULT_ITEM_STATES = ['active', 'blocked_until_rotated', 'tombstoned'] as const;
export const VaultItemStateSchema = z.enum(VAULT_ITEM_STATES);

/** MSG 12: a = confirmed exposed (rotate on import), b = plaintext under the owner's control, c = unknown (treated as b). */
export const VaultExposureTierSchema = z.enum(['a', 'b', 'c']);

export const VAULT_APPROVAL_KINDS = ['new_origin', 'grant', 'spend', 'property_change', 'use'] as const;
export const VaultApprovalKindSchema = z.enum(VAULT_APPROVAL_KINDS);
export const VAULT_APPROVAL_STATES = ['pending', 'approved', 'denied', 'expired', 'consumed'] as const;
export const VaultApprovalStateSchema = z.enum(VAULT_APPROVAL_STATES);

export const VAULT_HTTP_METHODS = ['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE'] as const;
export const VaultHttpMethodSchema = z.enum(VAULT_HTTP_METHODS);

export const VAULT_IMPORT_FORMATS = [
  'chrome_csv', 'firefox_csv', 'safari_csv', 'bitwarden_csv', 'bitwarden_json', 'onepassword_csv', 'generic_csv',
] as const;
export const VaultImportFormatSchema = z.enum(VAULT_IMPORT_FORMATS);

/** `error.details.reason` values the vault family adds. A reason never carries request data. */
export const VAULT_ERROR_REASONS = [
  /** `TM8_VAULT_MODE=off`. Every vault door answers this, and nothing else changes. */
  'vault_disabled',
  /** The broker is unreachable or unhealthy. Agents fail closed and never route around it (failure case 4). */
  'vault_unavailable',
  /** The audit write or the chain check failed. Fill, callApi, spend and grants refuse (MSG 11, test 18). */
  'audit_unavailable',
  'kms_unavailable',
  'vault_session_required',
  'step_up_required',
  /** A bad assertion, an unknown, used or expired challenge, or a parameter mismatch. One reason, so it is no oracle. */
  'step_up_invalid',
  /** The member has no passkey yet. Enrol one with an enrollment code. */
  'passkey_required',
  /** An enrollment or recovery code was wrong, used or expired. Rate limited. */
  'code_invalid',
  /** Wrong member, expired, used or unknown: one reason for all four (test 20). */
  'capture_link_invalid',
  /** The broker restarted and its capture key changed. Create a new link. */
  'capture_key_rotated',
  /** Exposure tier a: blocked until the source credential is rotated (MSG 12, test 16). */
  'item_blocked',
  'wrong_item_type',
  /** The origin is http, an IP literal, private or unparseable, outside the item's dev mode. */
  'origin_refused',
  'approval_not_pending',
  /** `approvalIntentHash` does not match the approval being decided. */
  'approval_hash_mismatch',
  /** The same `operationId` was sent with different parameters. */
  'operation_id_reused',
  /** v1 builds spend but keeps it off (owner decision, form revision 2). */
  'spend_disabled',
  'import_disabled',
  /** A pre-review cap: test secrets only, admins only, bounded item count. */
  'pre_review_limit',
  /** There is no reveal. The attempt is audited as suspicious and counts toward throttling (failure case 8). */
  'value_request_refused',
  /** Revoking the last passkey needs `confirmLast: true`. */
  'last_passkey',
] as const;
export type VaultErrorReason = (typeof VAULT_ERROR_REASONS)[number];

// ---------------------------------------------------------------------------
// Shared views
// ---------------------------------------------------------------------------

export const VaultActorSchema = z.object({
  kind: z.enum(['member', 'agent', 'system']),
  /** The member, for `member` and `agent` (an agent acts as its launching member). */
  memberId: Id.nullable(),
  /** The tm8 session that acted, when known. */
  sessionId: Id.nullable(),
  name: z.string().nullable(),
}).strict();
export type VaultActor = z.infer<typeof VaultActorSchema>;

export const VaultLookalikeFindingSchema = z.object({
  kind: z.enum(['confusable', 'mixed_script', 'edit_distance', 'brand_embedding']),
  /** The bound origin or well-known site the requested origin resembles. */
  similarTo: z.string().nullable(),
}).strict();

export const VaultKeyInjectionSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('bearer') }).strict(),
  z.object({ kind: z.literal('header'), name: z.string().regex(/^[A-Za-z0-9-]{1,64}$/), prefix: z.string().max(64).optional() }).strict(),
  z.object({ kind: z.literal('basic'), username: z.string().min(1).max(256) }).strict(),
  /** Generic mode only. The key appears in the request URL, so upstream logs may keep it. The UI labels it weaker. */
  z.object({ kind: z.literal('query'), name: z.string().regex(/^[A-Za-z0-9_.-]{1,64}$/) }).strict(),
]);

const PolicyFields = {
  /** `connector` = a vetted template (default). `generic` = owner-entered hosts, labelled weaker (MSG 5C). */
  mode: z.enum(['connector', 'generic']),
  connector: z.string().regex(/^[a-z][a-z0-9_-]{0,63}$/).nullable(),
  /** Exact lowercase hostnames. No wildcards, port 443 only. */
  hosts: z.array(z.string().min(1).max(253)).min(1).max(32),
  methods: z.array(VaultHttpMethodSchema).min(1).max(6),
  /** Each starts with `/`. Matched per path segment. */
  pathPrefixes: z.array(z.string().regex(/^\//).max(512)).min(1).max(64),
  maxRequestBytes: z.number().int().min(0).max(10 * 1024 * 1024),
  maxResponseBytes: z.number().int().min(1).max(10 * 1024 * 1024),
  injection: VaultKeyInjectionSchema,
};
export const VaultPolicyInputSchema = z.object(PolicyFields).strict();
export const VaultPolicyViewSchema = z.object({ version: z.number().int().positive(), ...PolicyFields }).strict();
export type VaultPolicyView = z.infer<typeof VaultPolicyViewSchema>;

/** One item, metadata only (R1: name, username, last-4, dates). */
export const VaultItemViewSchema = z.object({
  id: Id,
  /** Row version for `expectedVersion`. */
  version: z.number().int().positive(),
  type: VaultItemTypeSchema,
  name: z.string(),
  ownerMemberId: Id,
  /** `grant`: shared to the caller, shown as "shared by <owner>". */
  access: z.enum(['owner', 'grant']),
  sharedBy: z.object({ memberId: Id, name: z.string().nullable() }).strict().nullable(),
  state: VaultItemStateSchema,
  exposureTier: VaultExposureTierSchema.nullable(),
  /** Logins: the exact bound origins. For a grant recipient, only the origins the grant allows. */
  origins: z.array(z.string()),
  devMode: z.boolean(),
  username: z.string().nullable(),
  /** Cards: last 4 PAN digits. API keys: last 4 characters, only when the key is at least 20 long. */
  last4: z.string().length(4).nullable(),
  expMonth: z.number().int().min(1).max(12).nullable(),
  expYear: z.number().int().nullable(),
  connector: z.string().nullable(),
  hasTotp: z.boolean(),
  hasNotes: z.boolean(),
  /** Identity items: field NAMES only. */
  fieldNames: z.array(z.string()),
  /** Increments when the value is replaced (rotation). */
  secretVersion: z.number().int().positive(),
  createdAt: Iso,
  updatedAt: Iso,
  rotatedAt: Iso.nullable(),
}).strict();
export type VaultItemView = z.infer<typeof VaultItemViewSchema>;

export const VaultItemDetailSchema = VaultItemViewSchema.extend({
  /** API keys: the egress policy. Null until the owner sets one; until then `vault.callApi` refuses. */
  policy: VaultPolicyViewSchema.nullable(),
  pendingApprovals: z.number().int().nonnegative(),
  activeGrants: z.number().int().nonnegative(),
});
export type VaultItemDetail = z.infer<typeof VaultItemDetailSchema>;

const AuditParamValue = z.union([
  z.string().max(2048), z.number(), z.boolean(), z.null(), z.array(z.string().max(2048)).max(64),
]);

/** Fixed audit vocabulary (MSG 10). Params are metadata only: origins, hosts, methods, path prefixes, amounts, codes. */
export const VAULT_AUDIT_ACTIONS = [
  'item.captured', 'item.replaced', 'item.updated', 'item.properties_changed', 'item.deleted', 'item.imported',
  'policy.set',
  'fill.done', 'fill.refused', 'fill.unknown',
  'api.done', 'api.refused', 'api.unknown',
  'spend.requested', 'spend.executed', 'spend.refused', 'spend.unknown', 'spend.reconciled',
  'approval.requested', 'approval.approved', 'approval.denied', 'approval.expired', 'approval.consumed',
  'grant.created', 'grant.revoked', 'grant.dropped_on_leave',
  'capture.link_created', 'capture.link_refused',
  'session.signed_in', 'session.refreshed', 'session.ended', 'session.revoked', 'session.refresh_reuse_detected',
  'passkey.registered', 'passkey.revoked', 'passkey.new_device',
  'recovery.codes_created', 'recovery.code_used',
  'step_up.verified', 'step_up.failed',
  'import.begun', 'import.committed', 'import.cancelled',
  'value_request.refused', 'canary.detected', 'fill.repeated_failures',
  'audit.checkpoint', 'admin.enrollment_code_minted',
] as const;
export const VaultAuditActionSchema = z.enum(VAULT_AUDIT_ACTIONS);

export const VaultAuditEventViewSchema = z.object({
  seq: z.number().int().nonnegative(),
  at: Iso,
  action: VaultAuditActionSchema,
  actor: VaultActorSchema,
  itemId: Id.nullable(),
  params: z.record(AuditParamValue),
  prevHash: Hex64,
  entryHash: Hex64,
}).strict();
export type VaultAuditEventView = z.infer<typeof VaultAuditEventViewSchema>;

export const VaultApprovalViewSchema = z.object({
  id: Id,
  kind: VaultApprovalKindSchema,
  state: VaultApprovalStateSchema,
  /** One-use approvals are consumed by their first execution and never change the item (MSG 7B). */
  oneUse: z.boolean(),
  /** SHA-256 over every bound parameter. A step-up that approves this must name it in `approvalIntentHash`. */
  intentHash: Hex64,
  itemId: Id,
  itemName: z.string(),
  /** The exact parameters the owner approves: the item, the exact origin or host, the amount and currency, the requester and the expiry. */
  boundParams: z.record(AuditParamValue),
  requestedBy: VaultActorSchema,
  purpose: z.string().nullable(),
  /** Non-empty for a lookalike origin (test 4). The UI must show it prominently. */
  lookalike: z.array(VaultLookalikeFindingSchema),
  spend: z.object({
    merchant: z.string(),
    amountMinor: z.number().int().positive(),
    currency: z.string().regex(/^[A-Z]{3}$/),
    itemSummary: z.string(),
    instrumentTier: z.literal('tier1'),
  }).strict().nullable(),
  createdAt: Iso,
  expiresAt: Iso,
  decidedAt: Iso.nullable(),
  decidedBy: VaultActorSchema.nullable(),
  consumedAt: Iso.nullable(),
}).strict();
export type VaultApprovalView = z.infer<typeof VaultApprovalViewSchema>;

export const VaultGrantViewSchema = z.object({
  id: Id,
  itemId: Id,
  grantee: z.object({ kind: z.enum(['space', 'member']), id: Id, name: z.string().nullable() }).strict(),
  /** Use-only is the ONLY grant type. Nobody, admins included, can view a value (MSG 8). */
  constraints: z.object({
    origins: z.array(z.string()).nullable(),
    hosts: z.array(z.string()).nullable(),
    requireApprovalPerUse: z.boolean(),
  }).strict(),
  expiresAt: Iso.nullable(),
  createdAt: Iso,
  createdBy: VaultActorSchema,
  revokedAt: Iso.nullable(),
}).strict();
export type VaultGrantView = z.infer<typeof VaultGrantViewSchema>;

export const VaultSessionViewSchema = z.object({
  id: Id,
  passkeyId: Id,
  deviceLabel: z.string().nullable(),
  createdAt: Iso,
  lastUsedAt: Iso,
  expiresAt: Iso,
  refreshExpiresAt: Iso,
  current: z.boolean(),
  revokedAt: Iso.nullable(),
}).strict();
export type VaultSessionView = z.infer<typeof VaultSessionViewSchema>;

export const VaultPasskeyViewSchema = z.object({
  id: Id,
  name: z.string(),
  createdAt: Iso,
  lastUsedAt: Iso.nullable(),
  backedUp: z.boolean(),
  transports: z.array(z.string().max(32)).max(8),
  revokedAt: Iso.nullable(),
}).strict();
export type VaultPasskeyView = z.infer<typeof VaultPasskeyViewSchema>;

/** The broker's in-memory capture key (packages/vault capture/seal.ts). */
export const VaultCapturePublicKeySchema = z.object({
  kid: z.string().regex(/^[0-9a-f]{32}$/),
  /** Public coordinates only. The schema is strict, so a private `d` can never pass. */
  jwk: z.object({ kty: z.literal('EC'), crv: z.literal('P-256'), x: B64Url.length(43), y: B64Url.length(43), ext: z.literal(true) }).strict(),
  /** The 65-byte uncompressed point. */
  raw: B64Url.length(87),
}).strict();

/** ECIES envelope sealed in the owner's browser (scheme `tm8-vault-capture-v1`). */
export const VaultSealedEnvelopeSchema = z.object({
  v: z.literal(1),
  kid: z.string().regex(/^[0-9a-f]{32}$/),
  epk: B64Url.length(87),
  nonce: B64Url.length(16),
  ct: B64Url.min(23).max(Math.ceil((VAULT_MAX_IMPORT_CIPHERTEXT * 4) / 3) + 4),
}).strict();

export const VaultMaskedScreenshotSchema = z.object({
  mime: z.literal('image/png'),
  dataBase64: z.string().max(VAULT_MAX_SCREENSHOT_BASE64),
  width: z.number().int().positive(),
  height: z.number().int().positive(),
  /** Regions painted over: every form control, and any element whose text contains a filled value. */
  maskedRegions: z.number().int().nonnegative(),
}).strict();

// ---------------------------------------------------------------------------
// WebAuthn
// ---------------------------------------------------------------------------

const CredentialDescriptor = z.object({
  id: B64Url.min(1).max(1366),
  type: z.literal('public-key'),
  transports: z.array(z.string().max(32)).max(8).optional(),
}).strict();

/** `AuthenticationResponseJSON`, as `navigator.credentials.get` serializes it. */
export const VaultWebAuthnAssertionSchema = z.object({
  id: B64Url.min(1).max(1366),
  rawId: B64Url.min(1).max(1366),
  type: z.literal('public-key'),
  response: z.object({
    clientDataJSON: B64Url.max(8192),
    authenticatorData: B64Url.max(8192),
    signature: B64Url.max(2048),
    userHandle: B64Url.max(512).nullable().optional(),
  }).strict(),
  clientExtensionResults: z.record(z.unknown()),
  authenticatorAttachment: z.enum(['platform', 'cross-platform']).nullable().optional(),
}).strict();
export type VaultWebAuthnAssertion = z.infer<typeof VaultWebAuthnAssertionSchema>;

/** `RegistrationResponseJSON`, as `navigator.credentials.create` serializes it. */
export const VaultWebAuthnRegistrationSchema = z.object({
  id: B64Url.min(1).max(1366),
  rawId: B64Url.min(1).max(1366),
  type: z.literal('public-key'),
  response: z.object({
    clientDataJSON: B64Url.max(8192),
    attestationObject: B64Url.max(65536),
    authenticatorData: B64Url.max(65536).optional(),
    transports: z.array(z.string().max(32)).max(8).optional(),
    publicKeyAlgorithm: z.number().int().optional(),
    publicKey: B64Url.max(4096).optional(),
  }).strict(),
  clientExtensionResults: z.record(z.unknown()),
  authenticatorAttachment: z.enum(['platform', 'cross-platform']).nullable().optional(),
}).strict();

const Hints = z.array(z.enum(['security-key', 'client-device', 'hybrid'])).max(3);
const Extensions = z.record(z.unknown());

/** `PublicKeyCredentialRequestOptionsJSON`. User verification is always required. */
export const VaultWebAuthnRequestOptionsSchema = z.object({
  challenge: B64Url.min(43),
  rpId: z.string().min(1).max(253),
  timeout: z.number().int().positive(),
  userVerification: z.literal('required'),
  allowCredentials: z.array(CredentialDescriptor).max(32),
  hints: Hints.optional(),
  extensions: Extensions.optional(),
}).strict();

/** `PublicKeyCredentialCreationOptionsJSON`. */
export const VaultWebAuthnCreationOptionsSchema = z.object({
  challenge: B64Url.min(43),
  rp: z.object({ id: z.string().min(1).max(253), name: z.string().min(1).max(64) }).strict(),
  user: z.object({ id: B64Url.min(1).max(86), name: z.string().min(1).max(256), displayName: z.string().max(256) }).strict(),
  pubKeyCredParams: z.array(z.object({ type: z.literal('public-key'), alg: z.number().int() }).strict()).min(1).max(8),
  timeout: z.number().int().positive(),
  attestation: z.literal('none'),
  excludeCredentials: z.array(CredentialDescriptor).max(32),
  authenticatorSelection: z.object({
    residentKey: z.enum(['required', 'preferred', 'discouraged']),
    requireResidentKey: z.boolean().optional(),
    authenticatorAttachment: z.enum(['platform', 'cross-platform']).optional(),
    userVerification: z.literal('required'),
  }).strict(),
  hints: Hints.optional(),
  extensions: Extensions.optional(),
}).strict();

/** Proof of a fresh step-up, bound to the exact parameters of the call it rides on. */
export const VaultStepUpProofSchema = z.object({
  challengeId: Id,
  assertion: VaultWebAuthnAssertionSchema,
}).strict();
export type VaultStepUpProof = z.infer<typeof VaultStepUpProofSchema>;

/** Operations whose body carries `stepUp`. `vault.approvals.decide` requires it to approve, not to deny. */
export const VAULT_STEP_UP_ACTIONS = [
  'vault.captures.submit',
  'vault.approvals.decide',
  'vault.items.setProperties',
  'vault.items.delete',
  'vault.policies.set',
  'vault.grants.create',
  'vault.recovery.codes.create',
  'vault.imports.commit',
  'vault.passkeys.registerBegin',
] as const;
export const VaultStepUpActionSchema = z.enum(VAULT_STEP_UP_ACTIONS);
export type VaultStepUpAction = z.infer<typeof VaultStepUpActionSchema>;

/**
 * The parameters a step-up assertion covers. Both the challenge request and
 * the broker's check at execution time derive them with THIS function, so they
 * cannot disagree. It takes the body without `stepUp` and `clientMutationId`,
 * and each path param under `path.<name>`. The broker hashes the result as
 * `SHA-256("tm8-vault-stepup|v1|" + action + "|" + JCS(bound))` and derives the
 * WebAuthn challenge from that hash. If the call differs in any bound field,
 * it is refused with `step_up_invalid`.
 *
 * A body key that starts with `path.` throws, so a challenge body can never
 * shadow a path parameter.
 */
export function vaultStepUpBoundParams(
  pathParams: Readonly<Record<string, string>>,
  body: Readonly<Record<string, unknown>>,
): Record<string, unknown> {
  const bound: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(body)) {
    if (key.startsWith('path.')) throw new TypeError('a step-up body key may not start with "path."');
    if (key === 'stepUp' || key === 'clientMutationId' || value === undefined) continue;
    bound[key] = value;
  }
  for (const [key, value] of Object.entries(pathParams)) bound[`path.${key}`] = value;
  return bound;
}

// ---------------------------------------------------------------------------
// Inputs and outputs, per operation
// ---------------------------------------------------------------------------

export const VaultStatusInputSchema = z.object({}).strict();
export const VaultStatusSchema = z.object({
  mode: VaultModeSchema,
  /** `open` until the independent review AND the pen test pass. While open, only test secrets are allowed. */
  reviewGate: z.enum(['open', 'passed']),
  testSecretsOnly: z.boolean(),
  broker: z.enum(['ok', 'unavailable', 'disabled']),
  audit: z.enum(['ok', 'unavailable', 'disabled']),
  kms: z.object({ kind: z.string(), productionGrade: z.boolean() }).strict().nullable(),
  features: z.object({
    capture: z.boolean(),
    fill: z.boolean(),
    callApi: z.boolean(),
    /** Always false in v1 (owner decision, form revision 2). */
    spend: z.boolean(),
    import: z.boolean(),
    grants: z.boolean(),
  }).strict(),
  viewer: z.object({
    passkeys: z.number().int().nonnegative(),
    recoveryCodesRemaining: z.number().int().nonnegative().nullable(),
    vaultSession: z.object({ sessionId: Id, expiresAt: Iso }).strict().nullable(),
  }).strict(),
}).strict();
export type VaultStatus = z.infer<typeof VaultStatusSchema>;

export const VaultItemsListInputSchema = z.object({
  type: VaultItemTypeSchema.optional(),
  access: z.enum(['owner', 'grant']).optional(),
  cursor: Cursor.optional(),
  limit: Limit.optional(),
}).strict();
export const VaultItemsListSchema = z.object({ items: z.array(VaultItemViewSchema), nextCursor: Cursor.nullable() }).strict();

export const VaultItemsGetInputSchema = z.object({}).strict();

export const VaultItemActivityInputSchema = z.object({ days: z.coerce.number().int().min(1).max(90).optional() }).strict();
/** MSG 10: "used 3 times this week by agents X and Y on github.com". */
export const VaultItemActivitySchema = z.object({
  itemId: Id,
  windowDays: z.number().int().positive(),
  uses: z.array(z.object({
    actor: VaultActorSchema,
    fills: z.number().int().nonnegative(),
    apiCalls: z.number().int().nonnegative(),
    origins: z.array(z.string()),
    hosts: z.array(z.string()),
    lastAt: Iso,
  }).strict()),
  recent: z.array(VaultAuditEventViewSchema).max(50),
}).strict();

export const VaultCaptureLinkCreateInputSchema = z.object({
  ...Command,
  itemType: VaultItemTypeSchema,
  /** `replace` puts a new value on an existing item (rotation), and needs `itemId`. */
  purpose: z.enum(['create', 'replace']),
  itemId: Id.optional(),
  /** Suggested item name, shown on the capture page. Never a secret. */
  name: z.string().trim().min(1).max(200).optional(),
}).strict().refine((input) => (input.purpose === 'replace') === (input.itemId !== undefined), {
  message: 'itemId is required for replace and refused for create',
  path: ['itemId'],
});
export const VaultCaptureLinkSchema = z.object({
  captureId: Id,
  /**
   * Opens only in the owner's own signed-in browser, with a passkey. Single
   * use, 10 minutes. The URL FRAGMENT carries the link token. On its own the
   * token grants nothing: opening needs the owner's vault session, and
   * submitting needs a step-up.
   */
  url: z.string().url(),
  itemType: VaultItemTypeSchema,
  purpose: z.enum(['create', 'replace']),
  expiresAt: Iso,
}).strict();

const LinkToken = B64Url.length(43);

export const VaultCaptureOpenInputSchema = z.object({ ...Command, linkToken: LinkToken }).strict();
export const VaultCaptureOpenSchema = z.object({
  captureId: Id,
  itemType: VaultItemTypeSchema,
  purpose: z.enum(['create', 'replace']),
  itemId: Id.nullable(),
  itemName: z.string().nullable(),
  expiresAt: Iso,
  publicKey: VaultCapturePublicKeySchema,
  maxCiphertextBytes: z.number().int().positive(),
}).strict();

export const VaultCaptureSubmitInputSchema = z.object({
  ...Command,
  linkToken: LinkToken,
  sealed: VaultSealedEnvelopeSchema,
  stepUp: VaultStepUpProofSchema,
}).strict();

export const VaultFillInputSchema = z.object({
  operationId: Id,
  /** The exact origin, e.g. `https://github.com`. If it is not bound to the item, the result is `approval_required`. */
  origin: OriginInput,
  /** A page on the same origin. Defaults to `origin + "/"`. */
  startUrl: z.string().min(1).max(8192).optional(),
  submit: z.boolean(),
  purpose: Purpose,
}).strict();

export const VAULT_FILL_REFUSAL_CODES = [
  'origin_mismatch', 'cross_origin_redirect', 'cross_origin_form_action', 'insecure_context', 'not_top_frame',
  'fields_not_found', 'navigation_failed', 'timeout', 'browser_unavailable', 'grant_constraint',
] as const;
export const VaultFillRefusalCodeSchema = z.enum(VAULT_FILL_REFUSAL_CODES);

const ApprovalRequired = {
  state: z.literal('approval_required'),
  operationId: Id,
  itemId: Id,
  /** Final for THIS operationId. Once the owner approves, call again with a NEW operationId. */
  approvalId: Id,
  approvalKind: VaultApprovalKindSchema,
};

export const VaultFillResultSchema = z.discriminatedUnion('state', [
  z.object({ state: z.literal('done'), operationId: Id, itemId: Id, finalOrigin: z.string(), submitted: z.boolean(), screenshot: VaultMaskedScreenshotSchema.nullable() }).strict(),
  z.object({ state: z.literal('refused'), operationId: Id, itemId: Id, code: VaultFillRefusalCodeSchema, observedOrigin: z.string().nullable(), screenshot: VaultMaskedScreenshotSchema.nullable() }).strict(),
  z.object({ ...ApprovalRequired, origin: z.string(), lookalike: z.array(VaultLookalikeFindingSchema) }).strict(),
  /** The broker stopped mid-operation. It reconciles before anything new runs for this item. */
  z.object({ state: z.literal('unknown'), operationId: Id, itemId: Id }).strict(),
]);
export type VaultFillResult = z.infer<typeof VaultFillResultSchema>;

export const VaultApiRequestSchema = z.object({
  method: VaultHttpMethodSchema,
  /** Absolute https URL. A query is allowed. Credentials and fragments are refused. */
  url: z.string().min(1).max(8192),
  /** Authorization, Cookie, Proxy-*, Host, Forwarded, X-Forwarded-* and the injection header are refused. */
  headers: z.record(z.string().min(1).max(256), z.string().max(8192))
    .refine((headers) => Object.keys(headers).length <= 64, 'at most 64 headers')
    .optional(),
  body: z.discriminatedUnion('kind', [
    z.object({ kind: z.literal('json'), value: z.unknown().refine((value) => value !== undefined, 'value is required') }).strict(),
    z.object({ kind: z.literal('text'), value: z.string().max(1024 * 1024), contentType: z.string().max(256).optional() }).strict(),
  ]).optional(),
}).strict();

export const VaultCallApiInputSchema = z.object({
  operationId: Id,
  request: VaultApiRequestSchema,
  purpose: Purpose,
}).strict();

export const VAULT_EGRESS_REFUSAL_CODES = [
  'url_refused', 'scheme_refused', 'credentials_in_url', 'host_not_allowed', 'method_not_allowed', 'path_not_allowed',
  'token_management_denied', 'header_refused', 'body_too_large', 'private_address', 'dns_failed', 'redirect_refused',
  'canary_in_request', 'upstream_unreachable', 'timeout', 'policy_missing', 'grant_constraint',
] as const;
export const VaultEgressRefusalCodeSchema = z.enum(VAULT_EGRESS_REFUSAL_CODES);

export const VaultApiResponseSchema = z.object({
  status: z.number().int().min(100).max(599),
  /** Allowlisted response headers only, lowercase names. Never Set-Cookie. */
  headers: z.record(z.string()),
  body: z.discriminatedUnion('kind', [
    z.object({ kind: z.literal('json'), value: z.unknown() }).strict(),
    z.object({ kind: z.literal('text'), value: z.string() }).strict(),
    z.object({ kind: z.literal('empty') }).strict(),
    /** `replayed`: a retried operationId returns the stored status, but never a stored upstream body. */
    z.object({ kind: z.literal('withheld'), reason: z.enum(['canary', 'too_large', 'binary', 'replayed']) }).strict(),
  ]),
  /** Spans replaced with `[redacted]`: the key in any encoding, or a credential-shaped token. */
  redactions: z.number().int().nonnegative(),
}).strict();

export const VaultCallApiResultSchema = z.discriminatedUnion('state', [
  z.object({ state: z.literal('done'), operationId: Id, itemId: Id, response: VaultApiResponseSchema }).strict(),
  z.object({ state: z.literal('refused'), operationId: Id, itemId: Id, code: VaultEgressRefusalCodeSchema }).strict(),
  z.object(ApprovalRequired).strict(),
  z.object({ state: z.literal('unknown'), operationId: Id, itemId: Id }).strict(),
]);
export type VaultCallApiResult = z.infer<typeof VaultCallApiResultSchema>;

export const VaultOriginRequestInputSchema = z.object({
  ...Command,
  origin: OriginInput,
  /** `one_use` is consumed by one fill and never changes the item. `standing` adds the origin to the item. */
  mode: z.enum(['one_use', 'standing']),
  purpose: Purpose,
}).strict();

export const VaultSpendRequestInputSchema = z.object({
  ...Command,
  merchant: z.string().trim().min(1).max(200),
  /** The exact final amount shown at checkout, in minor units. */
  amountMinor: z.number().int().positive().max(1_000_000_000),
  currency: z.string().regex(/^[A-Z]{3}$/),
  itemSummary: z.string().trim().min(1).max(500),
  /** The checkout screenshot. It is evidence, not enforcement (MSG 7D). */
  evidence: VaultMaskedScreenshotSchema.optional(),
  purpose: Purpose,
}).strict();

export const VaultSpendExecuteInputSchema = z.object({ operationId: Id }).strict();

export const VAULT_SPEND_REFUSAL_CODES = [
  'spend_disabled', 'processor_not_configured', 'approval_not_approved', 'approval_consumed', 'amount_mismatch', 'processor_declined',
] as const;
export const VaultSpendResultSchema = z.discriminatedUnion('state', [
  z.object({
    state: z.literal('done'), operationId: Id, approvalId: Id, merchant: z.string(), amountMinor: z.number().int().positive(),
    currency: z.string(), processorRef: z.string().max(256),
  }).strict(),
  z.object({ state: z.literal('refused'), operationId: Id, approvalId: Id, code: z.enum(VAULT_SPEND_REFUSAL_CODES) }).strict(),
  z.object({ state: z.literal('unknown'), operationId: Id, approvalId: Id }).strict(),
]);

export const VaultOperationsGetInputSchema = z.object({}).strict();
const OperationBase = {
  operationId: Id,
  itemId: Id,
  state: z.enum(['in_progress', 'done', 'refused', 'approval_required', 'unknown']),
  createdAt: Iso,
  completedAt: Iso.nullable(),
};
/** `result` is the stored outcome, exactly as the original call returned it. It is null while `in_progress`. */
export const VaultOperationViewSchema = z.discriminatedUnion('kind', [
  z.object({ ...OperationBase, kind: z.literal('fill'), result: VaultFillResultSchema.nullable() }).strict(),
  z.object({ ...OperationBase, kind: z.literal('call_api'), result: VaultCallApiResultSchema.nullable() }).strict(),
  z.object({ ...OperationBase, kind: z.literal('spend'), result: VaultSpendResultSchema.nullable() }).strict(),
]);

export const VaultApprovalsListInputSchema = z.object({
  state: VaultApprovalStateSchema.optional(),
  itemId: Id.optional(),
  cursor: Cursor.optional(),
  limit: Limit.optional(),
}).strict();
export const VaultApprovalsListSchema = z.object({ approvals: z.array(VaultApprovalViewSchema), nextCursor: Cursor.nullable() }).strict();
export const VaultApprovalsGetInputSchema = z.object({}).strict();

export const VaultApprovalDecideInputSchema = z.object({
  ...Command,
  decision: z.enum(['approve', 'deny']),
  /** Must equal the approval's `intentHash`, so the owner's assertion covers the approval's bound parameters. */
  approvalIntentHash: Hex64,
  /** `new_origin` only: false = one-use (the default), true = standing. */
  standing: z.boolean().optional(),
  /** Required to approve. Denying needs only the vault session, so the safe direction is never harder. */
  stepUp: VaultStepUpProofSchema.optional(),
}).strict().refine((input) => input.decision === 'deny' || input.stepUp !== undefined, {
  message: 'approving needs a step-up proof',
  path: ['stepUp'],
});

export const VaultChallengeInputSchema = z.discriminatedUnion('purpose', [
  z.object({ ...Command, purpose: z.literal('sign_in') }).strict(),
  z.object({
    ...Command,
    purpose: z.literal('step_up'),
    action: VaultStepUpActionSchema,
    /** Exactly the path params and body the call will send. The broker binds them with `vaultStepUpBoundParams`. */
    pathParams: z.record(z.string().regex(/^[A-Za-z][A-Za-z0-9]{0,31}$/), z.string().min(1).max(128)),
    body: z.record(z.unknown()),
  }).strict(),
]);
export const VaultChallengeSchema = z.object({
  challengeId: Id,
  purpose: z.enum(['sign_in', 'step_up']),
  action: VaultStepUpActionSchema.nullable(),
  /** Step-up only: the hash the assertion will be bound to. */
  intentHash: Hex64.nullable(),
  expiresAt: Iso,
  publicKey: VaultWebAuthnRequestOptionsSchema,
}).strict();

export const VaultSessionBeginInputSchema = z.object({
  ...Command,
  challengeId: Id,
  assertion: VaultWebAuthnAssertionSchema,
  deviceLabel: z.string().trim().min(1).max(100).optional(),
}).strict();
export const VaultSessionRefreshInputSchema = z.object({ ...Command }).strict();
export const VaultSessionEndInputSchema = z.object({ ...Command }).strict();
export const VaultSessionEndSchema = z.object({ ended: z.literal(true) }).strict();
export const VaultSessionsListInputSchema = z.object({}).strict();
export const VaultSessionsListSchema = z.object({ sessions: z.array(VaultSessionViewSchema) }).strict();
export const VaultSessionRevokeInputSchema = z.object({ ...Command }).strict();

export const VaultPasskeysListInputSchema = z.object({}).strict();
export const VaultPasskeysListSchema = z.object({ passkeys: z.array(VaultPasskeyViewSchema) }).strict();

/**
 * Exactly one authorization:
 * - `enrollmentCode` for the FIRST passkey. It is minted out of band by the
 *   broker's own uid. A tm8 session cannot mint one.
 * - `recoveryCode` after a lost device. This revokes every vault session and
 *   notifies the owner.
 * - `stepUp` from an existing passkey, to add another.
 * Codes are Argon2id-hashed and rate limited. A code is a credential: the
 * relay never logs a body.
 */
export const VaultPasskeyRegisterBeginInputSchema = z.object({
  ...Command,
  name: StepUpLabel(64),
  enrollmentCode: z.string().min(8).max(64).optional(),
  recoveryCode: z.string().min(8).max(64).optional(),
  stepUp: VaultStepUpProofSchema.optional(),
}).strict().refine(
  (input) => [input.enrollmentCode, input.recoveryCode, input.stepUp].filter((value) => value !== undefined).length === 1,
  { message: 'exactly one of enrollmentCode, recoveryCode or stepUp' },
);
export const VaultPasskeyRegistrationSchema = z.object({
  registrationId: Id,
  expiresAt: Iso,
  publicKey: VaultWebAuthnCreationOptionsSchema,
}).strict();
export const VaultPasskeyRegisterFinishInputSchema = z.object({
  ...Command,
  credential: VaultWebAuthnRegistrationSchema,
}).strict();
export const VaultPasskeyRevokeInputSchema = z.object({ ...Command, confirmLast: z.boolean().optional() }).strict();

export const VaultItemUpdateInputSchema = z.object({
  ...Command,
  expectedVersion: z.number().int().positive(),
  name: z.string().trim().min(1).max(200).optional(),
  username: z.string().max(512).nullable().optional(),
}).strict().refine((input) => input.name !== undefined || input.username !== undefined, 'nothing to update');

export const VaultItemSetPropertiesInputSchema = z.object({
  ...Command,
  expectedVersion: z.number().int().positive(),
  addOrigins: z.array(OriginInput).max(20).optional(),
  removeOrigins: z.array(OriginInput).max(20).optional(),
  /** Dev mode allows named http, localhost and private origins on this item only. Off by default (MSG 6.6). */
  devMode: z.boolean().optional(),
  stepUp: VaultStepUpProofSchema,
}).strict().refine(
  (input) => input.addOrigins !== undefined || input.removeOrigins !== undefined || input.devMode !== undefined,
  'nothing to change',
);

export const VaultItemDeleteInputSchema = z.object({
  ...Command,
  expectedVersion: z.number().int().positive(),
  stepUp: VaultStepUpProofSchema,
}).strict();
/** Tombstoned: the wrapped DEKs and ciphertext are removed, and the deletion ledger keeps it dead across restores (MSG 9). */
export const VaultItemDeletedSchema = z.object({ itemId: Id, state: z.literal('tombstoned'), tombstonedAt: Iso }).strict();

export const VaultPolicySetInputSchema = z.object({
  ...Command,
  expectedVersion: z.number().int().positive(),
  policy: VaultPolicyInputSchema,
  stepUp: VaultStepUpProofSchema,
}).strict();

export const VaultGrantsListInputSchema = z.object({}).strict();
export const VaultGrantsListSchema = z.object({ grants: z.array(VaultGrantViewSchema) }).strict();
export const VaultGrantCreateInputSchema = z.object({
  ...Command,
  grantee: z.object({ kind: z.enum(['space', 'member']), id: Id }).strict(),
  constraints: z.object({
    /** A subset of the item's origins. Null = all of them. */
    origins: z.array(OriginInput).max(20).nullable(),
    /** A subset of the policy's hosts. Null = all of them. */
    hosts: z.array(z.string().min(1).max(253)).max(32).nullable(),
    requireApprovalPerUse: z.boolean(),
  }).strict(),
  expiresAt: Iso.nullable(),
  stepUp: VaultStepUpProofSchema,
}).strict();
export const VaultGrantRevokeInputSchema = z.object({ ...Command }).strict();

export const VaultRecoveryCodesCreateInputSchema = z.object({ ...Command, stepUp: VaultStepUpProofSchema }).strict();
/** THE ONE RESPONSE THAT CARRIES A CREDENTIAL. Shown once. Replaces every unused code. Stored Argon2id-hashed (MSG 9). */
export const VaultRecoveryCodesSchema = z.object({
  codes: z.array(z.string().min(8).max(64)).length(10),
  createdAt: Iso,
}).strict();

export const VaultImportBeginInputSchema = z.object({ ...Command, format: VaultImportFormatSchema.optional() }).strict();
export const VaultImportSessionSchema = z.object({
  importId: Id,
  expiresAt: Iso,
  publicKey: VaultCapturePublicKeySchema,
  maxCiphertextBytes: z.number().int().positive(),
}).strict();
export const VaultImportUploadInputSchema = z.object({ ...Command, sealed: VaultSealedEnvelopeSchema }).strict();
export const VaultImportCandidateSchema = z.object({
  index: z.number().int().nonnegative(),
  type: z.enum(['login', 'note', 'card']),
  name: z.string(),
  origin: z.string().nullable(),
  originError: z.string().nullable(),
  username: z.string().nullable(),
  hasPassword: z.boolean(),
  hasTotp: z.boolean(),
  duplicateOf: z.number().int().nonnegative().nullable(),
  /** Fixed vocabulary, e.g. `http_origin`, `notes_present`, `cvv_column_dropped`. */
  warnings: z.array(z.string().max(64)),
}).strict();
export const VaultImportPreviewSchema = z.object({
  importId: Id,
  format: VaultImportFormatSchema,
  candidates: z.array(VaultImportCandidateSchema),
  skipped: z.array(z.object({ index: z.number().int().nonnegative(), reason: z.string().max(64) }).strict()),
  expiresAt: Iso,
}).strict();
export const VaultImportCommitInputSchema = z.object({
  ...Command,
  rows: z.array(z.object({
    index: z.number().int().nonnegative(),
    include: z.boolean(),
    /** MSG 12. Tier a is stored blocked until the source credential is rotated. */
    exposureTier: VaultExposureTierSchema,
    name: StepUpLabel(200).optional(),
    /** Required for a row whose origin was refused. The broker refuses the row otherwise. */
    originOverride: OriginInput.optional(),
  }).strict()).min(1).max(5000),
  stepUp: VaultStepUpProofSchema,
}).strict();
export const VaultImportResultSchema = z.object({
  importId: Id,
  created: z.array(z.object({ index: z.number().int().nonnegative(), itemId: Id, state: VaultItemStateSchema }).strict()),
  skipped: z.array(z.object({ index: z.number().int().nonnegative(), reason: z.string().max(64) }).strict()),
  /** MSG 12.3: the export on disk is plaintext. The UI tells the owner to delete it. */
  deleteSourceAdvice: z.literal(true),
}).strict();
export const VaultImportCancelInputSchema = z.object({ ...Command }).strict();
export const VaultImportCancelledSchema = z.object({ importId: Id, state: z.literal('cancelled') }).strict();

export const VaultAuditListInputSchema = z.object({
  itemId: Id.optional(),
  action: VaultAuditActionSchema.optional(),
  cursor: Cursor.optional(),
  limit: Limit.optional(),
}).strict();
const ChainStatus = z.enum(['verified', 'broken', 'unverified']);
export const VaultAuditListSchema = z.object({
  events: z.array(VaultAuditEventViewSchema),
  nextCursor: Cursor.nullable(),
  chain: z.object({ status: ChainStatus, headSeq: z.number().int().nonnegative(), headHash: Hex64 }).strict(),
}).strict();
export const VaultAuditVerifyInputSchema = z.object({}).strict();
export const VaultAuditVerificationSchema = z.object({
  status: ChainStatus,
  checkedThroughSeq: z.number().int().nonnegative(),
  headHash: Hex64,
  firstBrokenSeq: z.number().int().nonnegative().nullable(),
  /** The latest signed checkpoint and where it went. `off` until the owner turns a sink on. */
  checkpoint: z.object({
    seq: z.number().int().nonnegative(),
    at: Iso,
    sink: z.enum(['off', 'file', 'gcs']),
    anchored: z.boolean(),
  }).strict().nullable(),
}).strict();

// ---------------------------------------------------------------------------
// The operation table
// ---------------------------------------------------------------------------

export type VaultAuthority = 'member' | 'human' | 'owner_session' | 'owner_step_up';

export interface VaultOperationRow {
  name: string;
  method: 'GET' | 'POST' | 'PATCH' | 'PUT';
  path: string;
  kind: 'read' | 'command';
  status: 'v1' | 'reserved';
  authority: VaultAuthority;
  humanOnly?: true;
}

/**
 * Every vault door. `status` stays `reserved` (an honest 501) until the broker
 * behind a row is built and its acceptance tests pass. Ops that need an owner
 * are `humanOnly`. The broker re-checks the passkey, because an agent can act
 * as the human at the tm8 door.
 */
export const VAULT_OPERATIONS = [
  // Agent-callable. Agents use items only through the broker and never see a value.
  { name: 'vault.status',              method: 'GET',  path: '/v2/vault/status',                             kind: 'read',    status: 'reserved', authority: 'member' },
  { name: 'vault.items.list',          method: 'GET',  path: '/v2/vault/items',                              kind: 'read',    status: 'reserved', authority: 'member' },
  { name: 'vault.items.get',           method: 'GET',  path: '/v2/vault/items/:itemId',                      kind: 'read',    status: 'reserved', authority: 'member' },
  { name: 'vault.items.activity',      method: 'GET',  path: '/v2/vault/items/:itemId/activity',             kind: 'read',    status: 'reserved', authority: 'member' },
  { name: 'vault.captureLinks.create', method: 'POST', path: '/v2/vault/capture-links',                      kind: 'command', status: 'reserved', authority: 'member' },
  { name: 'vault.fill',                method: 'POST', path: '/v2/vault/items/:itemId/fill',                 kind: 'command', status: 'reserved', authority: 'member' },
  { name: 'vault.callApi',             method: 'POST', path: '/v2/vault/items/:itemId/call',                 kind: 'command', status: 'reserved', authority: 'member' },
  { name: 'vault.origins.requestAdd',  method: 'POST', path: '/v2/vault/items/:itemId/origin-requests',      kind: 'command', status: 'reserved', authority: 'member' },
  { name: 'vault.spend.request',       method: 'POST', path: '/v2/vault/items/:itemId/spend-requests',       kind: 'command', status: 'reserved', authority: 'member' },
  { name: 'vault.spend.execute',       method: 'POST', path: '/v2/vault/approvals/:approvalId/spend',        kind: 'command', status: 'reserved', authority: 'member' },
  { name: 'vault.operations.get',      method: 'GET',  path: '/v2/vault/operations/:operationId',            kind: 'read',    status: 'reserved', authority: 'member' },
  { name: 'vault.approvals.list',      method: 'GET',  path: '/v2/vault/approvals',                          kind: 'read',    status: 'reserved', authority: 'member' },
  { name: 'vault.approvals.get',       method: 'GET',  path: '/v2/vault/approvals/:approvalId',              kind: 'read',    status: 'reserved', authority: 'member' },
  // Passkey ceremonies that create a vault session.
  { name: 'vault.webauthn.challenge',      method: 'POST', path: '/v2/vault/webauthn/challenges',                          kind: 'command', status: 'reserved', authority: 'human', humanOnly: true },
  { name: 'vault.session.begin',           method: 'POST', path: '/v2/vault/session',                                      kind: 'command', status: 'reserved', authority: 'human', humanOnly: true },
  { name: 'vault.session.refresh',         method: 'POST', path: '/v2/vault/session/refresh',                              kind: 'command', status: 'reserved', authority: 'human', humanOnly: true },
  { name: 'vault.session.end',             method: 'POST', path: '/v2/vault/session/end',                                  kind: 'command', status: 'reserved', authority: 'human', humanOnly: true },
  { name: 'vault.passkeys.registerBegin',  method: 'POST', path: '/v2/vault/passkeys/registrations',                       kind: 'command', status: 'reserved', authority: 'human', humanOnly: true },
  { name: 'vault.passkeys.registerFinish', method: 'POST', path: '/v2/vault/passkeys/registrations/:registrationId/finish', kind: 'command', status: 'reserved', authority: 'human', humanOnly: true },
  // Owner, with a vault session.
  { name: 'vault.sessions.list',       method: 'GET',  path: '/v2/vault/sessions',                           kind: 'read',    status: 'reserved', authority: 'owner_session', humanOnly: true },
  { name: 'vault.sessions.revoke',     method: 'POST', path: '/v2/vault/sessions/:sessionId/revoke',         kind: 'command', status: 'reserved', authority: 'owner_session', humanOnly: true },
  { name: 'vault.passkeys.list',       method: 'GET',  path: '/v2/vault/passkeys',                           kind: 'read',    status: 'reserved', authority: 'owner_session', humanOnly: true },
  { name: 'vault.passkeys.revoke',     method: 'POST', path: '/v2/vault/passkeys/:passkeyId/revoke',         kind: 'command', status: 'reserved', authority: 'owner_session', humanOnly: true },
  { name: 'vault.captures.open',       method: 'POST', path: '/v2/vault/captures/:captureId/open',           kind: 'command', status: 'reserved', authority: 'owner_session', humanOnly: true },
  { name: 'vault.approvals.decide',    method: 'POST', path: '/v2/vault/approvals/:approvalId/decide',       kind: 'command', status: 'reserved', authority: 'owner_session', humanOnly: true },
  { name: 'vault.items.update',        method: 'PATCH', path: '/v2/vault/items/:itemId',                     kind: 'command', status: 'reserved', authority: 'owner_session', humanOnly: true },
  { name: 'vault.grants.list',         method: 'GET',  path: '/v2/vault/items/:itemId/grants',               kind: 'read',    status: 'reserved', authority: 'owner_session', humanOnly: true },
  { name: 'vault.grants.revoke',       method: 'POST', path: '/v2/vault/grants/:grantId/revoke',             kind: 'command', status: 'reserved', authority: 'owner_session', humanOnly: true },
  { name: 'vault.imports.begin',       method: 'POST', path: '/v2/vault/imports',                            kind: 'command', status: 'reserved', authority: 'owner_session', humanOnly: true },
  { name: 'vault.imports.upload',      method: 'POST', path: '/v2/vault/imports/:importId/upload',           kind: 'command', status: 'reserved', authority: 'owner_session', humanOnly: true },
  { name: 'vault.imports.cancel',      method: 'POST', path: '/v2/vault/imports/:importId/cancel',           kind: 'command', status: 'reserved', authority: 'owner_session', humanOnly: true },
  { name: 'vault.audit.list',          method: 'GET',  path: '/v2/vault/audit',                              kind: 'read',    status: 'reserved', authority: 'owner_session', humanOnly: true },
  { name: 'vault.audit.verify',        method: 'GET',  path: '/v2/vault/audit/verification',                 kind: 'read',    status: 'reserved', authority: 'owner_session', humanOnly: true },
  // Owner, with a fresh step-up bound to the exact call.
  { name: 'vault.captures.submit',       method: 'POST', path: '/v2/vault/captures/:captureId/submit',       kind: 'command', status: 'reserved', authority: 'owner_step_up', humanOnly: true },
  { name: 'vault.items.setProperties',   method: 'POST', path: '/v2/vault/items/:itemId/properties',         kind: 'command', status: 'reserved', authority: 'owner_step_up', humanOnly: true },
  { name: 'vault.items.delete',          method: 'POST', path: '/v2/vault/items/:itemId/delete',             kind: 'command', status: 'reserved', authority: 'owner_step_up', humanOnly: true },
  { name: 'vault.policies.set',          method: 'PUT',  path: '/v2/vault/items/:itemId/policy',             kind: 'command', status: 'reserved', authority: 'owner_step_up', humanOnly: true },
  { name: 'vault.grants.create',         method: 'POST', path: '/v2/vault/items/:itemId/grants',             kind: 'command', status: 'reserved', authority: 'owner_step_up', humanOnly: true },
  { name: 'vault.recovery.codes.create', method: 'POST', path: '/v2/vault/recovery/codes',                   kind: 'command', status: 'reserved', authority: 'owner_step_up', humanOnly: true },
  { name: 'vault.imports.commit',        method: 'POST', path: '/v2/vault/imports/:importId/commit',         kind: 'command', status: 'reserved', authority: 'owner_step_up', humanOnly: true },
] as const satisfies readonly VaultOperationRow[];

export type VaultOperationName = (typeof VAULT_OPERATIONS)[number]['name'];

/** Input (body, or query for GET) per operation. Path params are not part of it. */
export const VAULT_INPUT_SCHEMAS = {
  'vault.status': VaultStatusInputSchema,
  'vault.items.list': VaultItemsListInputSchema,
  'vault.items.get': VaultItemsGetInputSchema,
  'vault.items.activity': VaultItemActivityInputSchema,
  'vault.captureLinks.create': VaultCaptureLinkCreateInputSchema,
  'vault.fill': VaultFillInputSchema,
  'vault.callApi': VaultCallApiInputSchema,
  'vault.origins.requestAdd': VaultOriginRequestInputSchema,
  'vault.spend.request': VaultSpendRequestInputSchema,
  'vault.spend.execute': VaultSpendExecuteInputSchema,
  'vault.operations.get': VaultOperationsGetInputSchema,
  'vault.approvals.list': VaultApprovalsListInputSchema,
  'vault.approvals.get': VaultApprovalsGetInputSchema,
  'vault.webauthn.challenge': VaultChallengeInputSchema,
  'vault.session.begin': VaultSessionBeginInputSchema,
  'vault.session.refresh': VaultSessionRefreshInputSchema,
  'vault.session.end': VaultSessionEndInputSchema,
  'vault.passkeys.registerBegin': VaultPasskeyRegisterBeginInputSchema,
  'vault.passkeys.registerFinish': VaultPasskeyRegisterFinishInputSchema,
  'vault.sessions.list': VaultSessionsListInputSchema,
  'vault.sessions.revoke': VaultSessionRevokeInputSchema,
  'vault.passkeys.list': VaultPasskeysListInputSchema,
  'vault.passkeys.revoke': VaultPasskeyRevokeInputSchema,
  'vault.captures.open': VaultCaptureOpenInputSchema,
  'vault.approvals.decide': VaultApprovalDecideInputSchema,
  'vault.items.update': VaultItemUpdateInputSchema,
  'vault.grants.list': VaultGrantsListInputSchema,
  'vault.grants.revoke': VaultGrantRevokeInputSchema,
  'vault.imports.begin': VaultImportBeginInputSchema,
  'vault.imports.upload': VaultImportUploadInputSchema,
  'vault.imports.cancel': VaultImportCancelInputSchema,
  'vault.audit.list': VaultAuditListInputSchema,
  'vault.audit.verify': VaultAuditVerifyInputSchema,
  'vault.captures.submit': VaultCaptureSubmitInputSchema,
  'vault.items.setProperties': VaultItemSetPropertiesInputSchema,
  'vault.items.delete': VaultItemDeleteInputSchema,
  'vault.policies.set': VaultPolicySetInputSchema,
  'vault.grants.create': VaultGrantCreateInputSchema,
  'vault.recovery.codes.create': VaultRecoveryCodesCreateInputSchema,
  'vault.imports.commit': VaultImportCommitInputSchema,
} as const satisfies { readonly [K in VaultOperationName]: z.ZodTypeAny };

/** Success output per operation. Acceptance test 1 sweeps these for any field that could hold a value. */
export const VAULT_OUTPUT_SCHEMAS = {
  'vault.status': VaultStatusSchema,
  'vault.items.list': VaultItemsListSchema,
  'vault.items.get': VaultItemDetailSchema,
  'vault.items.activity': VaultItemActivitySchema,
  'vault.captureLinks.create': VaultCaptureLinkSchema,
  'vault.fill': VaultFillResultSchema,
  'vault.callApi': VaultCallApiResultSchema,
  'vault.origins.requestAdd': VaultApprovalViewSchema,
  'vault.spend.request': VaultApprovalViewSchema,
  'vault.spend.execute': VaultSpendResultSchema,
  'vault.operations.get': VaultOperationViewSchema,
  'vault.approvals.list': VaultApprovalsListSchema,
  'vault.approvals.get': VaultApprovalViewSchema,
  'vault.webauthn.challenge': VaultChallengeSchema,
  'vault.session.begin': VaultSessionViewSchema,
  'vault.session.refresh': VaultSessionViewSchema,
  'vault.session.end': VaultSessionEndSchema,
  'vault.passkeys.registerBegin': VaultPasskeyRegistrationSchema,
  'vault.passkeys.registerFinish': VaultPasskeyViewSchema,
  'vault.sessions.list': VaultSessionsListSchema,
  'vault.sessions.revoke': VaultSessionViewSchema,
  'vault.passkeys.list': VaultPasskeysListSchema,
  'vault.passkeys.revoke': VaultPasskeyViewSchema,
  'vault.captures.open': VaultCaptureOpenSchema,
  'vault.approvals.decide': VaultApprovalViewSchema,
  'vault.items.update': VaultItemViewSchema,
  'vault.grants.list': VaultGrantsListSchema,
  'vault.grants.revoke': VaultGrantViewSchema,
  'vault.imports.begin': VaultImportSessionSchema,
  'vault.imports.upload': VaultImportPreviewSchema,
  'vault.imports.cancel': VaultImportCancelledSchema,
  'vault.audit.list': VaultAuditListSchema,
  'vault.audit.verify': VaultAuditVerificationSchema,
  'vault.captures.submit': VaultItemViewSchema,
  'vault.items.setProperties': VaultItemDetailSchema,
  'vault.items.delete': VaultItemDeletedSchema,
  'vault.policies.set': VaultItemDetailSchema,
  'vault.grants.create': VaultGrantViewSchema,
  'vault.recovery.codes.create': VaultRecoveryCodesSchema,
  'vault.imports.commit': VaultImportResultSchema,
} as const satisfies { readonly [K in VaultOperationName]: z.ZodTypeAny };

export type VaultInput<Op extends VaultOperationName> = z.input<(typeof VAULT_INPUT_SCHEMAS)[Op]>;
export type VaultOutput<Op extends VaultOperationName> = z.infer<(typeof VAULT_OUTPUT_SCHEMAS)[Op]>;
