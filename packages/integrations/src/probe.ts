import { ProviderCatalog } from './providers.js';
import { discoverOAuth } from './oauth.js';

const catalog = new ProviderCatalog();
const requested = process.argv.slice(2);
const providers = requested.length ? requested.map(id => {
  const provider = catalog.get(id);
  if (!provider) throw new Error(`Unknown provider: ${id}`);
  return provider;
}) : catalog.list();
const results = await Promise.all(providers.map(async provider => {
  if (provider.auth.kind === 'none') return { provider: provider.id, authentication: 'none' };
  try {
    const metadata = await discoverOAuth({ resource: provider.endpoint, ...('issuer' in provider.auth && provider.auth.issuer ? { issuer: provider.auth.issuer } : {}), allowPrivateNetwork: false });
    return { provider: provider.id, endpoint: provider.endpoint, metadata: 'verified', issuer: metadata.issuer,
      registration: metadata.registration_endpoint ? 'dynamic' : 'preregistered', pkce: 'S256',
      accountConsent: 'not tested', tools: 'not tested' };
  } catch (error) { return { provider: provider.id, metadata: 'failed', reason: error instanceof Error ? error.message : 'Discovery failed' }; }
}));
process.stdout.write(JSON.stringify({ timestamp: new Date().toISOString(), results }, null, 2) + '\n');
