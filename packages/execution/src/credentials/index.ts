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
  API_KEY_CREDENTIAL_PROVIDERS,
  API_KEY_FILENAME,
  API_KEY_PROVIDER_CONSOLE_URL,
  API_KEY_PROVIDER_DISPLAY_NAME,
  API_KEY_PROVIDER_KEY_PREFIX,
  API_KEY_PROVIDER_VERIFY_URL,
  apiKeyBackendAgentTool,
  apiKeyBackendDisplaces,
  apiKeyBackendEnv,
  apiKeyBackendOutrankedBy,
  apiKeyVerifyHeaders,
  isApiKeyBackend,
  API_KEY_PROVIDER_VERIFY_AUTH,
  apiKeyBackendsForAgentTool,
  isApiKeyCredentialProvider,
  type ApiKeyCredentialProvider,
} from './api-key-credentials.js';

export {
  CredentialSessionLauncher,
  credentialPastePath,
  CREDENTIAL_LOGIN_COMMANDS,
  type CredentialLaunchRequest,
  type CredentialLaunchResult,
  type CredentialSessionLauncherOptions,
} from './CredentialSessionLauncher.js';
