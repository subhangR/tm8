export { VaultSection, type VaultSectionProps } from './VaultSection';
export {
  createVaultPort, createStepUpRequester,
  type VaultPort, type VaultTransport, type VaultCallOptions, type VaultStepUpBody, type PasskeyAuthorization,
} from './port';
export { browserVaultAuthenticator, type VaultAuthenticator } from './webauthn';
export { VaultUiError, vaultError, vaultErrorMessage, VAULT_ERROR_COPY } from './errors';
export { MaskedScreenshot } from './ActivityPanels';
