// Tier 3 E2E fixture: deliberate type error so the 'typecheck + tests' check goes red.
// This PR exists to prove the forge watcher's CI-failure loop against a real check run.
export const tier3Fixture: number = 'ci-red on purpose';
