import { VAULT_CAPTURE_PAGE_PATH, VAULT_IMPORT_PAGE_PATH, type VaultOutput } from '@tm8/contract';
import { VaultUiError } from './errors';

/** The only navigation writes are these explicit, isolated new-tab actions. */
export function openVaultCapture(link: VaultOutput<'vault.captureLinks.create'>): void {
  let url: URL;
  try { url = new URL(link.url); } catch { throw new VaultUiError('unsafe_link'); }
  if (url.origin !== location.origin || url.username || url.password || url.search ||
      url.pathname !== `${VAULT_CAPTURE_PAGE_PATH}${link.captureId}` ||
      !/^#t=[A-Za-z0-9_-]{43}$/.test(url.hash)) {
    throw new VaultUiError('unsafe_link');
  }
  if (Date.parse(link.expiresAt) <= Date.now()) throw new VaultUiError('expired');
  window.open(url.href, '_blank', 'noopener,noreferrer');
}

export function openVaultImport(): void {
  window.open(VAULT_IMPORT_PAGE_PATH, '_blank', 'noopener,noreferrer');
}
