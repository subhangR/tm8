/**
 * Playwright 1.58.2 disables these features itself, then appends caller arguments
 * after its own without merging them, and Chromium may let a later
 * --disable-features replace an earlier one. Repeating Playwright's list keeps both
 * lists in force either way. test/browser/chromium-flags.test.ts fails when a
 * Playwright upgrade adds a feature that is missing here.
 */
export const PLAYWRIGHT_DISABLED_FEATURES = [
  'AvoidUnnecessaryBeforeUnloadCheckSync', 'BoundaryEventDispatchTracksNodeRemoval', 'DestroyProfileOnBrowserClose',
  'DialMediaRouteProvider', 'GlobalMediaControls', 'HttpsUpgrades', 'LensOverlay', 'MediaRouter', 'PaintHolding',
  'ThirdPartyStoragePartitioning', 'Translate', 'AutoDeElevate', 'RenderDocument', 'OptimizationHints',
] as const;

/** Worker additions: no remote autofill or password-manager onboarding. */
export const VAULT_DISABLED_FEATURES = ['AutofillServerCommunication', 'PasswordManagerOnboarding'] as const;

/** Fixed worker-owned flags. There is deliberately no caller-supplied flag list. */
export const CHROMIUM_FLAGS: readonly string[] = [
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
  `--disable-features=${[...PLAYWRIGHT_DISABLED_FEATURES, ...VAULT_DISABLED_FEATURES].join(',')}`, // Playwright's list plus no remote autofill or onboarding.
  '--disable-save-password-bubble', // Never offer to persist a filled password.
];
