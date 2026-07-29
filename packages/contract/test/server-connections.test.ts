import { describe, expect, it } from 'vitest';
import {
  ServerConnectionCreateInputSchema,
  ServerConnectionSchema,
} from '../src/index.js';

describe('ServerConnection schemas', () => {
  it('accepts the local named-route shape', () => {
    expect(ServerConnectionCreateInputSchema.parse({
      clientMutationId: 'add-work',
      name: 'work',
      baseUrl: 'http://127.0.0.1:4720',
      username: 'operator',
    })).toMatchObject({ name: 'work', baseUrl: 'http://127.0.0.1:4720' });

    expect(ServerConnectionSchema.safeParse({
      id: '00000000-0000-4000-8000-000000000001',
      name: 'work',
      baseUrl: 'http://127.0.0.1:4720',
      username: null,
      createdAt: '2026-07-29T00:00:00.000Z',
      updatedAt: '2026-07-29T00:00:00.000Z',
    }).success).toBe(true);
  });

  it('rejects credentials, paths, uppercase names, and unknown fields', () => {
    const base = { clientMutationId: 'add-work', name: 'work' };
    for (const baseUrl of [
      'http://user:password@127.0.0.1:4720',
      'http://127.0.0.1:4720/prefix',
      'ftp://127.0.0.1:4720',
    ]) {
      expect(ServerConnectionCreateInputSchema.safeParse({ ...base, baseUrl }).success).toBe(false);
    }
    expect(ServerConnectionCreateInputSchema.safeParse({ ...base, name: 'Work', baseUrl: 'http://127.0.0.1:4720' }).success)
      .toBe(false);
    expect(ServerConnectionCreateInputSchema.safeParse({ ...base, baseUrl: 'http://127.0.0.1:4720', password: 'secret' }).success)
      .toBe(false);
  });
});
