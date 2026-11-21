import { describe, expect, it, vi } from 'vitest';
import { MetadataTokenError, MetadataTokenSource } from '../../src/gcp/token.js';
import { expectSanitized, fakeToken, json, loopbackSuite, rejected } from './fake.js';

describe('MetadataTokenSource', () => {
  const fake = loopbackSuite();
  const tokenBody = () => ({ access_token: fakeToken, token_type: 'Bearer', expires_in: 3600 });

  it('requires metadata flavor on request and response; caches and refreshes single-flight 60 seconds early', async () => {
    let now = 0;
    const server = await fake((_, res) => {
      res.setHeader('Metadata-Flavor', 'Google');
      json(res, tokenBody());
    });
    const source = new MetadataTokenSource({ metadataBaseUrl: server.baseUrl, now: () => now });
    expect(await Promise.all(Array.from({ length: 20 }, () => source.getAccessToken()))).toEqual(Array(20).fill(fakeToken));
    expect(server.requests).toHaveLength(1);
    expect(server.requests[0]!.method).toBe('GET');
    expect(server.requests[0]!.url.pathname).toBe('/computeMetadata/v1/instance/service-accounts/default/token');
    expect(server.requests[0]!.headers['metadata-flavor']).toBe('Google');
    expect(server.requests[0]!.headers.authorization).toBeUndefined();
    now = 3_539_999;
    expect(await source.getAccessToken()).toBe(fakeToken);
    expect(server.requests).toHaveLength(1);
    now = 3_540_000;
    await Promise.all(Array.from({ length: 20 }, () => source.getAccessToken()));
    expect(server.requests).toHaveLength(2);
  });

  it.each([undefined, 'Other'])('refuses missing or wrong metadata flavor (%s)', async (flavor) => {
    const server = await fake((_, res) => {
      if (flavor) res.setHeader('Metadata-Flavor', flavor);
      json(res, tokenBody());
    });
    const error = await rejected(new MetadataTokenSource({ metadataBaseUrl: server.baseUrl }).getAccessToken());
    expect(error).toBeInstanceOf(MetadataTokenError);
    expectSanitized(error);
  });

  it.each([
    { expires_in: 0 }, { expires_in: -1 }, { expires_in: '3600' }, { expires_in: null },
    { access_token: '' }, { access_token: 123 }, { access_token: `${fakeToken}\n` }, { token_type: 'Basic' },
  ])('refuses malformed credentials %#', async (patch) => {
    const server = await fake((_, res) => {
      res.setHeader('Metadata-Flavor', 'Google');
      json(res, { ...tokenBody(), ...patch });
    });
    const error = await rejected(new MetadataTokenSource({ metadataBaseUrl: server.baseUrl }).getAccessToken());
    expect(error).toBeInstanceOf(MetadataTokenError);
    expectSanitized(error);
  });

  it('does not reuse expired cache or keep a rejected single-flight refresh', async () => {
    let now = 0;
    let healthy = true;
    const server = await fake((_, res) => {
      res.setHeader('Metadata-Flavor', 'Google');
      json(res, healthy ? tokenBody() : { error: fakeToken }, healthy ? 200 : 500);
    });
    const source = new MetadataTokenSource({ metadataBaseUrl: server.baseUrl, now: () => now });
    await source.getAccessToken();
    now = 3_540_000;
    healthy = false;
    const errors = await Promise.all(Array.from({ length: 10 }, () => rejected(source.getAccessToken())));
    expect(server.requests).toHaveLength(2);
    errors.forEach((error) => expectSanitized(error));
    healthy = true;
    expect(await source.getAccessToken()).toBe(fakeToken);
    expect(server.requests).toHaveLength(3);
  });

  it.each([400, 403, 404, 429, 500, 503])('sanitizes upstream status %s and response bodies', async (status) => {
    const server = await fake((_, res) => {
      res.setHeader('Metadata-Flavor', 'Google');
      json(res, { error: fakeToken }, status);
    });
    const error = await rejected(new MetadataTokenSource({ metadataBaseUrl: server.baseUrl }).getAccessToken());
    expect(error).toBeInstanceOf(MetadataTokenError);
    expectSanitized(error);
  });

  it.each(['disconnect', 'timeout', 'body-timeout', 'invalid-json', 'redirect'] as const)('sanitizes %s', async (mode) => {
    const server = await fake((_, res) => {
      res.setHeader('Metadata-Flavor', 'Google');
      if (mode === 'disconnect') { res.destroy(); return; }
      if (mode === 'timeout') return;
      if (mode === 'body-timeout') { res.writeHead(200).flushHeaders(); res.write('{'); return; }
      if (mode === 'redirect') { res.writeHead(302, { Location: 'https://metadata.google.internal/' }).end(); return; }
      res.end(fakeToken);
    });
    const error = await rejected(new MetadataTokenSource({ metadataBaseUrl: server.baseUrl, timeoutMs: 80 }).getAccessToken());
    expect(error).toBeInstanceOf(MetadataTokenError);
    expectSanitized(error);
  });

  it('never caches a token whose lifetime is under the safety margin', async () => {
    const server = await fake((_, res) => {
      res.setHeader('Metadata-Flavor', 'Google');
      json(res, { ...tokenBody(), expires_in: 30 });
    });
    const source = new MetadataTokenSource({ metadataBaseUrl: server.baseUrl });
    await source.getAccessToken();
    await source.getAccessToken();
    expect(server.requests).toHaveLength(2);
  });

  it('has a fetch guard that refuses real Google hosts before any connection', async () => {
    await expect(fetch('https://cloudkms.googleapis.com/')).rejects.toThrow('test fetch: non-loopback refused');
    await expect(fetch('http://metadata.google.internal/')).rejects.toThrow('test fetch: non-loopback refused');
    await expect(fetch('https://storage.googleapis.com/')).rejects.toThrow('test fetch: non-loopback refused');
  });

  it('never logs a token while an upstream response fails', async () => {
    const logs = [vi.spyOn(console, 'log'), vi.spyOn(console, 'warn'), vi.spyOn(console, 'error')];
    try {
      const server = await fake((_, res) => json(res, { error: fakeToken }, 500));
      await rejected(new MetadataTokenSource({ metadataBaseUrl: server.baseUrl }).getAccessToken());
      for (const log of logs) expect(log).not.toHaveBeenCalled();
    } finally { logs.forEach((log) => log.mockRestore()); }
  });
});
