/**
 * The agent harness surface: bootstrap manifest, kernel assembly, scoped
 * credentials.
 *
 * This is the CLI-side half of the harness. The prompt-side half — the §5.2
 * kernel template, the §14 trusted-control templates, the §18 escaping and the
 * §8.1 budgets — lives in `@tm8/prompt`, which has zero dependencies so the
 * spawn path and the CLI can both compose an identical prompt without either
 * importing the other.
 *
 * Nothing here is wired into `run.ts`: command registration belongs to the
 * discovery slot that owns the router. These are exported handlers and
 * composers, ready to register.
 */
export * from './bootstrap-manifest.js';
export * from './bootstrap.js';
export * from './secrets.js';
