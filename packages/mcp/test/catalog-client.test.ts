import { describe, expect, it, vi } from 'vitest';
import { CatalogHttpError, HttpCatalogClient } from '../src/catalog-client.js';

describe('catalog-backed HTTP client', () => {
  it('binds method/path/query from the catalog and carries the runtime bearer', async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () =>
      new Response(JSON.stringify({ data: { id: 'entity' }, requestId: 'req' }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }));
    const client = new HttpCatalogClient({
      baseUrl: 'http://127.0.0.1:4610',
      token: 'tm8s_session.super-secret',
      fetchImpl,
    });

    await client.invoke('entities.context', {
      params: { id: '019fa297-64e3-7000-8000-000000000001' },
      query: { sections: 'summary,actions', tag: ['a', 'b'] },
    });

    const [url, init] = fetchImpl.mock.calls[0]!;
    expect(String(url)).toBe(
      'http://127.0.0.1:4610/v2/entities/019fa297-64e3-7000-8000-000000000001/context?sections=summary%2Cactions&tag=a&tag=b',
    );
    expect(init?.method).toBe('GET');
    expect((init?.headers as Record<string, string>).authorization).toBe('Bearer tm8s_session.super-secret');
  });

  it('returns only envelope data', async () => {
    const client = new HttpCatalogClient({
      baseUrl: 'http://127.0.0.1:4610',
      token: 'secret',
      fetchImpl: async () => new Response(JSON.stringify({ data: { page: [] }, requestId: 'req' })),
    });
    await expect(client.invoke('collections.query', { body: { spaceId: 'space' } })).resolves.toEqual({ page: [] });
  });

  it('preserves structured facade errors without ever including the bearer', async () => {
    const token = 'tm8s_session.never-print-this';
    const client = new HttpCatalogClient({
      baseUrl: 'http://127.0.0.1:4610',
      token,
      fetchImpl: async () =>
        new Response(
          JSON.stringify({ error: { code: 'forbidden', message: 'not allowed', retryable: false } }),
          { status: 403 },
        ),
    });

    let caught: unknown;
    try {
      await client.invoke('entities.get', { params: { id: 'denied' } });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(CatalogHttpError);
    expect(caught).toMatchObject({ code: 'forbidden', status: 403, retryable: false });
    expect(JSON.stringify(caught)).not.toContain(token);
    expect(String(caught)).not.toContain(token);
  });
});
