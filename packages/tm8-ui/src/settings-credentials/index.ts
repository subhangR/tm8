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
  ServiceKeysBlock,
  SERVICE_KEY_PRESENTATIONS,
  type ServiceKeysBlockProps,
} from './ServiceKeysBlock';
export {
  credentialsPortFromSeam,
  serviceKeysPortFromSeam,
  sharesPortFromSeam,
  disconnectVerdictOf,
  verdictOf,
  type ConnectionVerdict,
  type CredentialsPort,
  type DisconnectVerdict,
  type ServiceKeysPort,
  type SharesPort,
} from './port';
export { SharesBlock, shareTokenSentence, type SharesBlockProps } from './SharesBlock';
export {
  SpaceCredentialsSection,
  type SpaceCredentialsSectionProps,
} from './SpaceCredentialsSection';
export {
  NodeCredentialsSection,
  NODE_POLICY_ADMIN_ONLY,
  type NodeCredentialsSectionProps,
} from './NodeCredentialsSection';
export {
  spaceCredentialsPortFromSeam,
  isSpaceAdminRole,
  type SpaceCredentialsPort,
  type SpaceCredentialsViewer,
  type SpaceLoginProvider,
  type SpaceLoginTarget,
} from './space-port';
export * from './space-credentials-model';
