/** Fixed worker-owned flags. There is deliberately no caller-supplied flag list. */
export const CHROMIUM_FLAGS = [
  '--disable-extensions', // No extension can observe credential fields or cookies.
  '--disable-component-extensions-with-background-pages', // No bundled extension background pages.
  '--disable-background-networking', // Suppress browser background services and telemetry.
  '--disable-sync', // No account sync or profile export.
  '--disable-breakpad', // No crash reporter or minidumps containing page memory.
  '--disable-crash-reporter', // No alternate crash reporting backend.
  '--disk-cache-size=0', // Disable HTTP disk caching in the ephemeral profile.
  '--media-cache-size=0', // Disable media disk caching.
  '--no-first-run', // No first-run UI or profile import.
  '--no-default-browser-check', // No OS integration prompt.
  '--password-store=basic', // No host keyring or external credential-store integration.
  '--use-mock-keychain', // No platform keychain access.
  '--disable-features=MediaRouter,OptimizationHints,AutofillServerCommunication,PasswordManagerOnboarding', // No discovery, remote autofill or password-manager onboarding.
  '--disable-save-password-bubble', // Never offer to persist a filled password.
] as const;
