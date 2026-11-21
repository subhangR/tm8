import type { AuditGate, BrokerConfig } from '../core-types.js';
import { VaultError } from '../core-types.js';
import { assertBrokerConfig, loadBrokerConfig } from './config.js';
import { createBrokerServer, type BrokerServer, type BrokerServerOptions } from './server.js';

export interface StartBrokerDependencies extends Omit<BrokerServerOptions, 'config'> {
  env?: Readonly<Record<string, string | undefined>>;
  config?: BrokerConfig;
  beforeServe?: readonly (() => Promise<void>)[];
  /**
   * Steps that need a verified chain, such as anchoring its head (review F01).
   * The chain and its anchor are verified again after them.
   */
  afterVerify?: readonly (() => Promise<void>)[];
}

async function requireVerified(audit: AuditGate): Promise<void> {
  if ((await audit.verifyIncremental()).status !== 'verified') throw VaultError.reason('audit_unavailable');
}

/**
 * No socket is bound until all startup gates, including ledger replay, have
 * finished, and never while the audit gate is unhealthy: a chain that verifies
 * but whose anchor is stale is not served either.
 */
export async function startBroker(deps: StartBrokerDependencies): Promise<BrokerServer> {
  const config = deps.config ?? loadBrokerConfig(deps.env ?? process.env, deps.components.kms);
  assertBrokerConfig(config, deps.components.kms);
  if (!(await deps.components.kms.health()).ok) throw VaultError.reason('kms_unavailable');
  if (!(await deps.store.health()).ok) throw VaultError.reason('vault_unavailable');
  for (const step of deps.beforeServe ?? []) await step();
  await requireVerified(deps.audit);
  if (deps.afterVerify && deps.afterVerify.length > 0) {
    for (const step of deps.afterVerify) await step();
    await requireVerified(deps.audit);
  }
  deps.audit.assertHealthy();
  const server = await createBrokerServer({ ...deps, config });
  await server.listen();
  return server;
}
