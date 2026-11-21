import { afterEach, describe, expect, it, vi } from 'vitest';

/**
 * Review F06: the browser and database security suites are release gates. Off CI they skip with a
 * reason when their harness is absent; on a GitHub runner (GITHUB_ACTIONS=true, as db/target.mjs
 * reads it) the same run fails instead, so a skip can never be reported as a pass.
 */
describe('vault suites cannot skip on a CI runner (review F06)', () => {
  afterEach(() => { vi.unstubAllEnvs(); vi.resetModules(); });

  async function load(env: Record<string, string>) {
    for (const [name, value] of Object.entries(env)) vi.stubEnv(name, value);
    vi.resetModules();
    const [browser, store] = await Promise.allSettled([import('./browser/fixtures.js'), import('./store/pg-harness.js')]);
    return { browser, store };
  }

  it('on a runner, the browser suites refuse to load without TM8_VAULT_BROWSER_E2E=1', async () => {
    const { browser } = await load({ GITHUB_ACTIONS: 'true', TM8_VAULT_BROWSER_E2E: '' });
    expect(browser.status).toBe('rejected');
    expect(String((browser as PromiseRejectedResult).reason)).toContain('vault browser suites cannot be skipped on a CI runner');
  });

  it('on a runner, the database suites refuse to load without TM8_VAULT_PG_URL', async () => {
    const { store } = await load({ GITHUB_ACTIONS: 'true', TM8_VAULT_PG_URL: '' });
    expect(store.status).toBe('rejected');
    expect(String((store as PromiseRejectedResult).reason)).toContain('vault Postgres suites cannot be skipped on a CI runner');
  });

  it('on a runner with both harnesses configured, both load enabled', async () => {
    const { browser, store } = await load({ GITHUB_ACTIONS: 'true', TM8_VAULT_BROWSER_E2E: '1',
      TM8_VAULT_PG_URL: 'postgres://vault_test_admin@127.0.0.1:55400/postgres' });
    expect(browser).toMatchObject({ status: 'fulfilled', value: { e2eEnabled: true } });
    expect(store).toMatchObject({ status: 'fulfilled', value: { PG_ENABLED: true } });
  });

  it('off a runner, both load and skip with their reason', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      const { browser, store } = await load({ GITHUB_ACTIONS: '', TM8_VAULT_BROWSER_E2E: '', TM8_VAULT_PG_URL: '' });
      expect(browser).toMatchObject({ status: 'fulfilled', value: { e2eEnabled: false } });
      expect(store).toMatchObject({ status: 'fulfilled', value: { PG_ENABLED: false } });
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('Vault Postgres tests SKIPPED'));
    } finally { warn.mockRestore(); }
  });
});
