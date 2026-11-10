import { ProviderCatalog } from '@tm8/integrations';
import { CollabError } from '@tm8/contract';

const providers = new ProviderCatalog();

/** Deployment-owned client identity. Only exact curated identities may use these secrets. */
export function providerClient(catalogId: string | undefined, endpoint: string, read: (name: string) => string | undefined) {
  const provider = catalogId ? providers.get(catalogId) : undefined;
  if (!provider || provider.endpoint !== endpoint || !('configurationKey' in provider.auth)) return undefined;
  const key = provider.auth.configurationKey;
  const clientId = read(`TM8_MCP_CLIENT_ID_${key}`);
  const clientSecret = read(`TM8_MCP_CLIENT_SECRET_${key}`);
  if (!clientId) {
    if (provider.auth.kind === 'registered') throw new CollabError('invalid_input', `OAuth client setup required: ${provider.title} is awaiting setup by the server operator. Configure TM8_MCP_CLIENT_ID_${key} and TM8_MCP_CLIENT_SECRET_${key}.`);
    return undefined;
  }
  if (provider.auth.kind === 'registered' && !clientSecret) throw new CollabError('invalid_input', `OAuth client setup required: ${provider.title} client secret is not configured on this server.`);
  return { clientId, ...(clientSecret ? { clientSecret } : {}) };
}
