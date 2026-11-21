import type { BrokerConfig } from '../core-types.js';
import { VaultError } from '../core-types.js';
import { assertBrokerConfig, loadBrokerConfig } from './config.js';
import { createBrokerServer, type BrokerServer, type BrokerServerOptions } from './server.js';

export interface StartBrokerDependencies extends Omit<BrokerServerOptions, 'config'> {
  env?: Readonly<Record<string, string | undefined>>;
  config?: BrokerConfig;
  beforeServe?: readonly (() => Promise<void>)[];
}

/** No socket is bound until all startup gates, including ledger replay, have finished. */
export async function startBroker(deps: StartBrokerDependencies): Promise<BrokerServer> {
  const config = deps.config ?? loadBrokerConfig(deps.env ?? process.env, deps.components.kms);
  assertBrokerConfig(config, deps.components.kms);
  if (!(await deps.components.kms.health()).ok) throw VaultError.reason('kms_unavailable');
  if (!(await deps.store.health()).ok) throw VaultError.reason('vault_unavailable');
  for (const step of deps.beforeServe ?? []) await step();
  const verification = await deps.audit.verifyIncremental();
  if (verification.status !== 'verified') throw VaultError.reason('audit_unavailable');
  const server = await createBrokerServer({ ...deps, config });
  await server.listen();
  return server;
}
