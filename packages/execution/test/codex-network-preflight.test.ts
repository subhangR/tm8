import { describe, expect, it } from 'vitest';
import {
  assertCodexNetworkFeatureList,
  assertCodexNetworkRuntimeVersion,
  MINIMUM_CODEX_LOOPBACK_PROXY_VERSION,
  preflightCodexNetworkPolicy,
} from '../src/spawn/codex-network-preflight.js';
import { resolveAgentBinary } from '../src/spawn/manifest.js';
import { SpawnError } from '../src/spawn/types.js';

describe('Codex network policy preflight', () => {
  const installedCodex = resolveAgentBinary('codex', process.env.PATH ?? '');
  const itWithCodex = installedCodex ? it : it.skip;

  itWithCodex('the installed CLI either passes or fails with the compatibility gate', async () => {
    const result = await preflightCodexNetworkPolicy(
      installedCodex as string,
      process.env,
    ).then(
      () => ({ ok: true as const }),
      (error: unknown) => ({ ok: false as const, error }),
    );
    if (!result.ok) {
      expect(result.error).toBeInstanceOf(SpawnError);
      expect(result.error).toMatchObject({
        code: 'not_implemented',
        detail: { minimumVersion: MINIMUM_CODEX_LOOPBACK_PROXY_VERSION },
      });
    }
  });

  it('accepts an installed feature only when the tm8 override enabled it', () => {
    expect(() =>
      assertCodexNetworkFeatureList(
        'shell_tool stable true\nnetwork_proxy experimental true\n',
      ),
    ).not.toThrow();
  });

  it.each([
    ['missing', 'shell_tool stable true\n'],
    ['disabled', 'network_proxy experimental false\n'],
    ['removed', 'network_proxy removed true\n'],
  ])('fails clearly when network_proxy is %s', (_name, output) => {
    let caught: unknown;
    try {
      assertCodexNetworkFeatureList(output, '/opt/bin/codex');
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(SpawnError);
    expect(caught).toMatchObject({
      code: 'not_implemented',
      detail: { binary: '/opt/bin/codex', requiredFeature: 'network_proxy' },
    });
    expect((caught as Error).message).toContain('update Codex');
  });

  it.each([
    ['codex-cli 0.145.0', false],
    ['codex-cli 0.145.9', false],
    ['codex-cli 0.146.0', true],
    ['codex-cli 1.0.0', true],
  ])('validates loopback proxy runtime version %s', (output, supported) => {
    const run = () => assertCodexNetworkRuntimeVersion(output, '/opt/bin/codex');
    if (supported) expect(run).not.toThrow();
    else expect(run).toThrow(/cannot safely route exact loopback hosts/u);
  });

  it('fails closed when the Codex version cannot be parsed', () => {
    expect(() => assertCodexNetworkRuntimeVersion('codex unknown')).toThrow(/unknown/u);
  });
});
