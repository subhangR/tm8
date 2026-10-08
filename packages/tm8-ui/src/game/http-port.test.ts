// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { TM8_CLIENT_HEADER, TM8_CLIENT_HEADER_VALUE, type GameNavigationView } from '@tm8/contract';
import { createHttpClient } from '../data/real/http';
import { createGamePort } from './http-port';
import { DurableGameSave } from './durable-save';
import { enterGameMap, freshGameSave, mapKey, rememberGameMap, writeGameSave } from './local-save';
const SPACE = '00000000-0000-4000-8000-000000000001', MEMBER = '00000000-0000-4000-8000-000000000002';
const STORY = '00000000-0000-4000-8000-000000000003';
beforeEach(() => window.localStorage.clear());

describe('authenticated catalog Game port', () => {
  it('opens every valid legacy map before migration and retains exact current/prior pose and camera', async () => {
    const visited = new Set<string>(), requests: { url: string; init?: RequestInit }[] = [];
    let revision = 0;
    let stored: GameNavigationView['save'] = null;
    const fetch = vi.fn(async (url: string, init?: RequestInit) => {
      requests.push({ url, init });
      const body = init?.body ? JSON.parse(String(init.body)) : undefined;
      let data: unknown;
      if (url.endsWith('/maps/open')) {
        const key = mapKey(body); visited.add(key);
        data = { id: key, spaceId: SPACE, title: 'Map', type: body.type, scope: body.scope };
      } else {
        if (init?.method === 'PUT') {
          expect(body.expectedRevision).toBe(revision);
          expect(Object.keys(body.save.maps).every(key => visited.has(key))).toBe(true);
          stored = body.save; revision++;
        }
        data = { spaceId: SPACE, memberId: MEMBER, save: stored, revision, repairs: { routeTruncated: false, droppedMemories: 0 } };
      }
      return new Response(JSON.stringify({ data }), { status: 200 });
    });
    let mutation = 0;
    const game = createGamePort(createHttpClient({ fetch, getAuthToken: () => 'synthetic-token' }), prefix => `${prefix}:${++mutation}`);
    const fresh = freshGameSave(SPACE, MEMBER), rootKey = mapKey(fresh.current);
    const nested = enterGameMap(enterGameMap(fresh, { type: 'hub', scope: { kind: 'story', id: STORY } }), { type: 'taskland', scope: { kind: 'story', id: STORY } });
    const camera = { zoom: 3.25, position: [1, 20, 3] as [number, number, number], target: [7, 0, 9] as [number, number, number] };
    const legacy = rememberGameMap(rememberGameMap(nested, rootKey, { position: { x: 7, z: 9 }, camera }),
      mapKey(nested.current), { position: { x: -4.5, z: 8.25 }, camera });
    const malformed = rememberGameMap(legacy, JSON.stringify(['story', 'legacy-nonuuid', 'taskland']), { position: { x: 99, z: 99 } });
    writeGameSave(malformed);
    const queue = new DurableGameSave(SPACE, MEMBER, game, vi.fn());
    const restored = await queue.hydrate(new AbortController().signal);
    expect(restored).toEqual(legacy);
    expect(visited.size).toBe(3);
    await queue.enqueue(restored, true);
    expect(stored).toEqual(legacy);
    expect(requests.some(({ init }) => String(init?.body).includes('legacy-nonuuid'))).toBe(false);
    const last = requests.at(-1)!;
    expect(last.url).toBe(`/v2/spaces/${SPACE}/maps/navigation`);
    expect(last.init?.method).toBe('PUT'); expect(last.init?.keepalive).toBe(true);
    expect(last.init?.headers).toMatchObject({ authorization: 'Bearer synthetic-token', [TM8_CLIENT_HEADER]: TM8_CLIENT_HEADER_VALUE });
  });

  it('aborts Game requests through the normal transport without reporting the node unreachable', async () => {
    const onTransport = vi.fn(), controller = new AbortController();
    const fetch = vi.fn((_url: string, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => reject(new DOMException('cancel', 'AbortError')), { once: true });
    }));
    const game = createGamePort(createHttpClient({ fetch, onTransport }));
    const reading = game.load(SPACE, controller.signal);
    const rejected = expect(reading).rejects.toMatchObject({ name: 'AbortError' });
    controller.abort(); await rejected;
    expect(onTransport).not.toHaveBeenCalledWith(false);
  });
});
