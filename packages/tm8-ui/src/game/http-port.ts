import type { HttpClient } from '../data/real/http';
import type { GamePort } from './port';

export function createGamePort(http: HttpClient, mutationId: (prefix: string) => string = () => crypto.randomUUID()): GamePort {
  const port: GamePort = {
    open: (spaceId, selection, signal) => http.call('maps.open', {
      params: { spaceId }, body: { type: selection.type, scope: selection.scope, clientMutationId: mutationId('game-open') }, signal,
    }),
    context: (mapId, cursor, signal) => http.call('maps.context', { params: { mapId }, query: { limit: 100, cursor }, signal }),
    load: (spaceId, signal) => http.call('maps.navigation.get', { params: { spaceId }, signal }),
    save: (spaceId, save, expectedRevision, options) => http.call('maps.navigation.save', {
      params: { spaceId }, body: { save, expectedRevision, clientMutationId: mutationId('game-save') }, keepalive: options?.keepalive, signal: options?.signal,
    }),
    async prepareMigration(spaceId, save, signal) {
      const selections = new Map<string, { type: typeof save.current.type; scope: typeof save.current.scope }>();
      const add = (map: typeof save.current) => selections.set(JSON.stringify([map.scope.kind, map.scope.id, map.type]), map);
      for (const map of [...save.stack, save.current]) add(map);
      for (const key of Object.keys(save.maps)) {
        const [kind, id, type] = JSON.parse(key);
        add({ type, scope: { kind, id } });
      }
      // Canonical saves bound this list at 193; four requests at a time avoid a fan-out burst.
      const remaining = [...selections.values()];
      let failed = false;
      await Promise.all(Array.from({ length: Math.min(4, remaining.length) }, async () => {
        while (remaining.length && !failed) {
          if (signal?.aborted) throw new DOMException('Game migration cancelled', 'AbortError');
          const map = remaining.shift()!;
          try { await port.open(spaceId, map, signal); }
          catch (error) {
            const code = error && typeof error === 'object' && 'code' in error ? error.code : null;
            // Live scope repair is performed by the server. A transport failure must retain local memories.
            if (!['not_found', 'forbidden', 'invalid_input', 'validation_error'].includes(String(code))) { failed = true; throw error; }
          }
        }
      }));
    },
  };
  return port;
}
