import { ServerConnectionSchema, type ServerConnection } from '@tm8/contract';
import { Tm8Client } from './client.js';
import type { CliContext } from './context.js';
import { ProtocolError } from './errors.js';

/** Resolve a name through Server A, then route the requested command directly to Server B. */
export async function resolveServerTarget(
  registryContext: CliContext,
  name: string,
): Promise<CliContext> {
  const registryClient = new Tm8Client({
    baseUrl: registryContext.baseUrl.value,
    token: registryContext.token,
    timeoutMs: registryContext.timeoutMs,
  });
  const raw = await registryClient.invoke<ServerConnection>('serverConnections.get', {
    params: { name },
  });
  const parsed = ServerConnectionSchema.safeParse(raw);
  if (!parsed.success) {
    throw new ProtocolError(
      `serverConnections.get returned an invalid ServerConnection: ${parsed.error.message}`,
      200,
      raw,
    );
  }
  return {
    ...registryContext,
    baseUrl: { value: parsed.data.baseUrl, source: 'flag' },
    // Server A's token belongs to A: never leak one node's bearer material to
    // another origin. Dispatch refills this from the per-server credential
    // store under B's OWN origin (run.ts), or leaves it absent — identity is
    // end-to-end between the client and the authority Server; a hop is a
    // pipe, never an identity boundary.
    token: undefined,
  };
}
