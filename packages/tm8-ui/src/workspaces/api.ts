import { readActivePass } from '../auth/pass-store';
import { readActiveServerId, routeBaseUrlFor } from '../servers/server-key';

export async function workspaceApi<T>(path: string, body?: unknown): Promise<T> {
  const publicRequest = path === '/v2/deployment/capabilities';
  const token = publicRequest ? undefined : readActivePass()?.token;
  const response = await fetch(`${routeBaseUrlFor(readActiveServerId())}${path}`, {
    method: body === undefined ? 'GET' : 'POST', credentials: publicRequest ? 'omit' : 'same-origin',
    headers: { 'X-TM8-Client': 'tm8-ui', ...(body === undefined ? {} : { 'content-type': 'application/json' }), ...(token ? { authorization: `Bearer ${token}` } : {}) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(150000),
  });
  const result = await response.json() as { data: T; error?: { message?: string; code?: string } };
  if (!response.ok) throw new Error(result.error?.message ?? result.error?.code ?? `Request failed (${response.status})`);
  return result.data;
}
