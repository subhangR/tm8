import type { BrokerConfig } from '../core-types.js';
import type { KmsProvider } from '../crypto/kms.js';

/** Every environment value consumed here. Transport credentials are supplied by the composition root. */
export const BROKER_ENV_KNOBS = [
  { name: 'TM8_VAULT_MODE', default: 'off', meaning: 'off, dev, pre_review or production' },
  { name: 'TM8_VAULT_REVIEW_GATE', default: 'open', meaning: 'passed only after both independent security gates' },
  { name: 'TM8_VAULT_KMS_KIND', default: 'local-dev', meaning: 'KMS adapter; production requires a production-grade adapter' },
  { name: 'TM8_VAULT_PUBLIC_ORIGIN', default: 'http://localhost:5173', meaning: 'Public tm8 origin used for capture links' },
  { name: 'TM8_VAULT_WEBAUTHN_RP_ID', default: 'public origin hostname', meaning: 'WebAuthn relying party id' },
  { name: 'TM8_VAULT_WEBAUTHN_RP_NAME', default: 'tm8 Vault', meaning: 'WebAuthn relying party display name' },
  { name: 'TM8_VAULT_WEBAUTHN_ORIGINS', default: 'public origin', meaning: 'Comma-separated exact browser origins' },
  { name: 'TM8_VAULT_CAPTURE', default: 'true', meaning: 'Enable capture' },
  { name: 'TM8_VAULT_FILL', default: 'true', meaning: 'Enable login fill' },
  { name: 'TM8_VAULT_CALL_API', default: 'true', meaning: 'Enable API use' },
  { name: 'TM8_VAULT_IMPORT', default: 'true', meaning: 'Enable import outside pre_review' },
  { name: 'TM8_VAULT_GRANTS', default: 'true', meaning: 'Enable use-only sharing' },
  { name: 'TM8_VAULT_SPEND', default: 'false', meaning: 'Must remain false in v1' },
  { name: 'TM8_VAULT_PRE_REVIEW_MAX_ITEMS', default: '20', meaning: 'Maximum owned live items in pre_review' },
  { name: 'TM8_VAULT_PRE_REVIEW_FILL_ORIGINS', default: '', meaning: 'Comma-separated exact test origins' },
  { name: 'TM8_VAULT_PRE_REVIEW_API_HOSTS', default: '', meaning: 'Comma-separated exact test API hosts' },
  { name: 'TM8_VAULT_AUDIT_SINK', default: 'off', meaning: 'off, file or gcs checkpoint sink' },
] as const;

export class BrokerConfigError extends Error {
  constructor(readonly knob: string) {
    super(`vault broker: invalid ${knob}`);
    this.name = 'BrokerConfigError';
  }
}

type Env = Readonly<Record<string, string | undefined>>;
const invalid = (knob: string): never => { throw new BrokerConfigError(knob); };

function choice<const T extends readonly string[]>(env: Env, knob: string, values: T, fallback: T[number]): T[number] {
  const value = env[knob] ?? fallback;
  if (!values.includes(value)) return invalid(knob);
  return value as T[number];
}

function flag(env: Env, knob: string, fallback = true): boolean {
  const value = env[knob];
  if (value === undefined) return fallback;
  if (value === 'true') return true;
  if (value === 'false') return false;
  return invalid(knob);
}

function origin(value: string, knob: string, production: boolean): string {
  try {
    const url = new URL(value);
    if (url.username || url.password || url.search || url.hash || value.includes('?') || value.includes('#')
      || !['https:', 'http:'].includes(url.protocol) || url.pathname !== '/' || /[\s\\]/.test(value)) return invalid(knob);
    if (url.protocol === 'http:' && (production || !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname))) return invalid(knob);
    return url.origin;
  } catch { return invalid(knob); }
}

function list(env: Env, knob: string): string[] {
  const value = env[knob];
  if (value === undefined || value === '') return [];
  const values = value.split(',').map((part) => part.trim());
  if (values.some((part) => part === '') || values.length > 64) return invalid(knob);
  return [...new Set(values)];
}

/** Also called for injected configs, so tests and composition roots cannot bypass the production gate. */
export function assertBrokerConfig(config: BrokerConfig, kms?: Pick<KmsProvider, 'kind' | 'productionGrade'>): void {
  if (config.features.spend !== false) invalid('TM8_VAULT_SPEND');
  if (config.mode === 'production') {
    if (config.reviewGate !== 'passed') invalid('TM8_VAULT_REVIEW_GATE');
    if (!kms?.productionGrade || kms.kind === 'local-dev') invalid('TM8_VAULT_KMS_KIND');
  }
}

/** No error includes an environment value, including malformed URLs. */
export function loadBrokerConfig(env: Env, kms?: Pick<KmsProvider, 'kind' | 'productionGrade'>): BrokerConfig {
  const mode = choice(env, 'TM8_VAULT_MODE', ['off', 'dev', 'pre_review', 'production'] as const, 'off');
  const reviewGate = choice(env, 'TM8_VAULT_REVIEW_GATE', ['open', 'passed'] as const, 'open');
  const kmsKind = choice(env, 'TM8_VAULT_KMS_KIND', ['local-dev', 'gcp-kms', 'vault-transit', 'test-fake'] as const, kms?.kind ?? 'local-dev');
  if (kms && kmsKind !== kms.kind) invalid('TM8_VAULT_KMS_KIND');
  if (mode === 'production' && reviewGate !== 'passed') invalid('TM8_VAULT_REVIEW_GATE');
  if (mode === 'production' && (kmsKind === 'local-dev' || !kms?.productionGrade)) invalid('TM8_VAULT_KMS_KIND');
  const publicOrigin = origin(env.TM8_VAULT_PUBLIC_ORIGIN ?? 'http://localhost:5173', 'TM8_VAULT_PUBLIC_ORIGIN', mode === 'production');
  const rpId = env.TM8_VAULT_WEBAUTHN_RP_ID ?? new URL(publicOrigin).hostname;
  if (!/^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)*[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(rpId)) invalid('TM8_VAULT_WEBAUTHN_RP_ID');
  const rpName = env.TM8_VAULT_WEBAUTHN_RP_NAME ?? 'tm8 Vault';
  if (rpName.length < 1 || rpName.length > 64 || /[\u0000-\u001f\u007f]/.test(rpName)) invalid('TM8_VAULT_WEBAUTHN_RP_NAME');
  const origins = env.TM8_VAULT_WEBAUTHN_ORIGINS === undefined ? [publicOrigin]
    : list(env, 'TM8_VAULT_WEBAUTHN_ORIGINS').map((value) => origin(value, 'TM8_VAULT_WEBAUTHN_ORIGINS', mode === 'production'));
  if (origins.length === 0 || origins.some((value) => {
    const host = new URL(value).hostname;
    return host !== rpId && !host.endsWith(`.${rpId}`);
  })) invalid('TM8_VAULT_WEBAUTHN_ORIGINS');
  const maxItems = env.TM8_VAULT_PRE_REVIEW_MAX_ITEMS ?? '20';
  if (!/^[1-9][0-9]*$/.test(maxItems) || Number(maxItems) > 5000) invalid('TM8_VAULT_PRE_REVIEW_MAX_ITEMS');
  const allowedFillOrigins = list(env, 'TM8_VAULT_PRE_REVIEW_FILL_ORIGINS')
    .map((value) => origin(value, 'TM8_VAULT_PRE_REVIEW_FILL_ORIGINS', false));
  const allowedApiHosts = list(env, 'TM8_VAULT_PRE_REVIEW_API_HOSTS');
  if (allowedApiHosts.some((host) => !/^(?=.{1,253}$)[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/.test(host)
    || host.includes('..') || host.split('.').some((label) => label.length > 63 || label.startsWith('-') || label.endsWith('-')))) invalid('TM8_VAULT_PRE_REVIEW_API_HOSTS');
  if (flag(env, 'TM8_VAULT_SPEND', false)) invalid('TM8_VAULT_SPEND');
  const config: BrokerConfig = {
    mode, reviewGate, publicOrigin, webauthn: { rpId, rpName, origins },
    features: { capture: flag(env, 'TM8_VAULT_CAPTURE'), fill: flag(env, 'TM8_VAULT_FILL'), callApi: flag(env, 'TM8_VAULT_CALL_API'),
      spend: false, import: flag(env, 'TM8_VAULT_IMPORT') && mode !== 'pre_review', grants: flag(env, 'TM8_VAULT_GRANTS') },
    preReview: { maxItemsPerMember: Number(maxItems), allowedFillOrigins, allowedApiHosts },
    auditSink: choice(env, 'TM8_VAULT_AUDIT_SINK', ['off', 'file', 'gcs'] as const, 'off'),
  };
  assertBrokerConfig(config, kms);
  return config;
}
