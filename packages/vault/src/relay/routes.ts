import {
  VAULT_MAX_CAPTURE_CIPHERTEXT, VAULT_MAX_IMPORT_CIPHERTEXT, VAULT_OPERATIONS, type VaultOperationName,
} from '@tm8/contract';

/**
 * The route table and body caps both ends of the relay read. The tm8 server's
 * relay answers an unknown method and path with 404 without contacting the
 * broker, and stops reading a body at its cap. The broker matches and caps
 * again on its own, so neither side relies on the other's check.
 */

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ROUTES = VAULT_OPERATIONS.map((row) => ({ row, parts: row.path.split('/') }));

export interface VaultRoute {
  row: (typeof VAULT_OPERATIONS)[number];
  params: Record<string, string>;
}

/** Exact method and segment match; a path parameter must be a UUID and is returned lower-cased. */
export function matchVaultRoute(method: string, path: string): VaultRoute | null {
  const parts = path.split('/');
  for (const { row, parts: template } of ROUTES) {
    if (row.method !== method || parts.length !== template.length) continue;
    const params: Record<string, string> = {};
    let matches = true;
    for (let i = 0; i < template.length; i += 1) {
      const segment = template[i]!;
      if (segment.startsWith(':')) {
        const value = parts[i]!;
        if (!UUID.test(value)) { matches = false; break; }
        params[segment.slice(1)] = value.toLowerCase();
      } else if (segment !== parts[i]) { matches = false; break; }
    }
    if (matches) return { row, params };
  }
  return null;
}

/** Base64 of the largest sealed payload plus 32 KiB of JSON around it. */
export const VAULT_BODY_LIMITS = Object.freeze({
  small: 128 * 1024,
  capture: Math.ceil(4 * VAULT_MAX_CAPTURE_CIPHERTEXT / 3) + 32 * 1024,
  import: Math.ceil(4 * VAULT_MAX_IMPORT_CIPHERTEXT / 3) + 32 * 1024,
});

export function vaultBodyLimit(name: VaultOperationName | null | undefined): number {
  return name === 'vault.imports.upload' ? VAULT_BODY_LIMITS.import
    : name === 'vault.captures.submit' ? VAULT_BODY_LIMITS.capture : VAULT_BODY_LIMITS.small;
}
