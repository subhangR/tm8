/**
 * `settings-credentials/` — the per-member agent credentials surface.
 *
 * `CredentialsProviderBlock` is the one implementation mounted by both Home
 * and the Settings wrapper. The port remains the only seam adapter either host
 * hands to it.
 */
export { CredentialsSection, type CredentialsSectionProps } from './CredentialsSection';
export {
  CredentialsProviderBlock,
  type CredentialsProviderBlockProps,
} from './CredentialsProviderBlock';
export {
  CREDENTIAL_PROVIDER_PRESENTATIONS,
  presentationOf,
  type CredentialProviderPresentation,
} from './provider-presentation';
export {
  CredentialsSetupDialog,
  type CredentialsSetupDialogProps,
} from './CredentialsSetupDialog';
export {
  clearSetupDismissal,
  readSetupDismissed,
  writeSetupDismissed,
} from './setup-dismissal';
export {
  credentialSetupState,
  setupNudgeOf,
  shouldOfferSetup,
  GIT_PROVIDER,
  type CredentialSetupState,
  type ProviderStanding,
} from './setup-gate';
export {
  credentialsPortFromSeam,
  disconnectVerdictOf,
  verdictOf,
  type ConnectionVerdict,
  type CredentialsPort,
  type DisconnectVerdict,
} from './port';
