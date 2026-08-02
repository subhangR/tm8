// Validate the installed Codex CLI before a tm8-owned sandboxed session boots.
//
// The network policy is intentionally command-line-owned. A developer's
// ~/.codex/config.toml may add unrelated defaults, but tm8 never relies on it
// for loopback reachability. `features list` is used as a capability probe: it
// both parses the exact tm8 overrides and proves that this binary knows the
// network_proxy feature before the worker is allowed to start.

import { execFile } from 'node:child_process';
import { codexLoopbackConfigArgs } from './manifest.js';
import { SpawnError } from './types.js';

/**
 * Codex 0.145.0 advertises `network_proxy` but injects loopback/private hosts
 * into NO_PROXY even when `allow_local_binding=false`. On sandboxed macOS that
 * makes exact 127.0.0.1 requests bypass the proxy and fail; on less restrictive
 * platforms it can bypass the intended destination policy. 0.146.0 is the
 * first runtime generation tm8 accepts for this policy.
 */
export const MINIMUM_CODEX_LOOPBACK_PROXY_VERSION = '0.146.0';

export type CodexNetworkPreflight = (
  binary: string,
  env: NodeJS.ProcessEnv,
) => Promise<void>;

function execFileText(
  binary: string,
  args: readonly string[],
  env: NodeJS.ProcessEnv,
): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      binary,
      [...args],
      {
        env,
        timeout: 5_000,
        maxBuffer: 1024 * 1024,
        windowsHide: true,
      },
      (error, stdout) => {
        if (error) reject(error);
        else resolve(stdout);
      },
    );
  });
}

/**
 * Fail closed when Codex cannot parse or activate tm8's network proxy policy.
 */
export const preflightCodexNetworkPolicy: CodexNetworkPreflight = async (binary, env) => {
  let features: string;
  let version: string;
  try {
    [features, version] = await Promise.all([
      execFileText(binary, [...codexLoopbackConfigArgs(), 'features', 'list'], env),
      execFileText(binary, ['--version'], env),
    ]);
  } catch {
    throw new SpawnError(
      "installed Codex CLI cannot validate tm8's required loopback command-network policy; " +
        'update Codex to a version with `features network_proxy`, then retry',
      'not_implemented',
      { binary, requiredFeature: 'network_proxy' },
    );
  }

  assertCodexNetworkFeatureList(features, binary);
  assertCodexNetworkRuntimeVersion(version, binary);
};

/** Pure feature-list validator, separated so unsupported-version behavior is pinned. */
export function assertCodexNetworkFeatureList(features: string, binary = 'codex'): void {
  const line = features
    .split(/\r?\n/u)
    .find((candidate) => candidate.trimStart().startsWith('network_proxy'));
  const columns = line?.trim().split(/\s+/u) ?? [];
  const enabled = columns.at(-1) === 'true';
  const removed = columns.includes('removed');
  if (!line || !enabled || removed) {
    throw new SpawnError(
      "installed Codex CLI does not support tm8's required enabled network_proxy feature; " +
        'update Codex before spawning graph-working workers',
      'not_implemented',
      { binary, requiredFeature: 'network_proxy' },
    );
  }
}

/** Reject known legacy runtimes that parse the policy but cannot enforce it. */
export function assertCodexNetworkRuntimeVersion(
  output: string,
  binary = 'codex',
): void {
  const match = output.match(/\b(\d+)\.(\d+)\.(\d+)(?:[-+][0-9A-Za-z.-]+)?\b/u);
  if (!match) {
    throw unsupportedCodexVersion(binary, 'unknown');
  }

  const installed = [Number(match[1]), Number(match[2]), Number(match[3])] as const;
  const minimum = MINIMUM_CODEX_LOOPBACK_PROXY_VERSION.split('.').map(Number) as [
    number,
    number,
    number,
  ];
  for (let index = 0; index < minimum.length; index += 1) {
    const actualPart = installed[index] ?? 0;
    const minimumPart = minimum[index] ?? 0;
    if (actualPart > minimumPart) return;
    if (actualPart < minimumPart) {
      throw unsupportedCodexVersion(binary, installed.join('.'));
    }
  }
}

function unsupportedCodexVersion(binary: string, installedVersion: string): SpawnError {
  return new SpawnError(
    `installed Codex CLI ${installedVersion} cannot safely route exact loopback hosts through ` +
      `tm8's command proxy; update to Codex ${MINIMUM_CODEX_LOOPBACK_PROXY_VERSION} or newer`,
    'not_implemented',
    {
      binary,
      installedVersion,
      minimumVersion: MINIMUM_CODEX_LOOPBACK_PROXY_VERSION,
      requiredFeature: 'network_proxy',
    },
  );
}
