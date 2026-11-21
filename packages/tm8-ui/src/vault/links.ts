import { VAULT_CAPTURE_PAGE_PATH, VAULT_IMPORT_PAGE_PATH, type VaultOutput } from '@tm8/contract';
import { VaultUiError } from './errors';

const SPACE_ID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
/** Exactly the broker's shape: the link token, then the space the page acts in. */
const CAPTURE_FRAGMENT = new RegExp(`^#t=[A-Za-z0-9_-]{43}&s=${SPACE_ID}$`);

/** The only navigation writes are these explicit, isolated new-tab actions. */
export function openVaultCapture(link: VaultOutput<'vault.captureLinks.create'>): void {
  let url: URL;
  try { url = new URL(link.url); } catch { throw new VaultUiError('unsafe_link'); }
  if (url.origin !== location.origin || url.username || url.password || url.search ||
      url.pathname !== `${VAULT_CAPTURE_PAGE_PATH}${link.captureId}` ||
      !CAPTURE_FRAGMENT.test(url.hash)) {
    throw new VaultUiError('unsafe_link');
  }
  if (Date.parse(link.expiresAt) <= Date.now()) throw new VaultUiError('expired');
  window.open(url.href, '_blank', 'noopener,noreferrer');
}

/** The import page in the port's space; with none, the relay needs a single membership. */
export function vaultImportPageUrl(spaceId: string | null): string {
  if (spaceId === null) return VAULT_IMPORT_PAGE_PATH;
  if (!new RegExp(`^${SPACE_ID}$`).test(spaceId)) throw new VaultUiError('unsafe_link');
  return `${VAULT_IMPORT_PAGE_PATH}#s=${spaceId}`;
}

export function openVaultImport(spaceId: string | null): void {
  window.open(vaultImportPageUrl(spaceId), '_blank', 'noopener,noreferrer');
}
