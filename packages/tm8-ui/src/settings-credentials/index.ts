/**
 * `settings-credentials/` — the per-member agent credentials section.
 *
 * Built in its own module and injected into `SettingsShell` through its
 * `sections` slot, which is the seam that lets two lanes meet without editing
 * each other's files.
 */
export { CredentialsSection, type CredentialsSectionProps } from './CredentialsSection';
export {
  credentialsPortFromSeam,
  disconnectVerdictOf,
  verdictOf,
  type ConnectionVerdict,
  type CredentialsPort,
  type DisconnectVerdict,
} from './port';
