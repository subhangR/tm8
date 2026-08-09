// @tm8/execution — the vendor-login (Tier B credential) block.
//
// Kept in its own directory rather than folded into `spawn/` so that the
// separation §A3 insists on is visible in the file tree and not only in a
// comment: nothing here composes an agent environment, and nothing in `spawn/`
// composes a login environment.

export {
  composeCredentialEnv,
  credentialEnvKeys,
  CREDENTIAL_CONFIG_DIR_VAR,
  CREDENTIAL_ENV_BASE_KEYS,
  CREDENTIAL_PROVIDERS,
  type ComposeCredentialEnvInput,
  type CredentialProvider,
} from './credential-env.js';

export {
  CredentialSessionLauncher,
  CREDENTIAL_LOGIN_COMMANDS,
  type CredentialLaunchRequest,
  type CredentialLaunchResult,
  type CredentialSessionLauncherOptions,
} from './CredentialSessionLauncher.js';
