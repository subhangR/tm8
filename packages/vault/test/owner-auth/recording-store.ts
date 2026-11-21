import type { StoreScope, VaultStore, VaultTx } from '../../src/core-types.js';

/** Records all repository arguments, results and errors, including writes later rolled back. */
export class RecordingStore implements VaultStore {
  readonly calls: { repo: string; method: string; args: unknown[]; result?: unknown; error?: string }[] = [];
  beforeCall?: (repo: string, method: string) => void;
  constructor(readonly inner: VaultStore) {}

  transaction<T>(scope: StoreScope, fn: (tx: VaultTx) => Promise<T>): Promise<T> {
    return this.inner.transaction(scope, async (tx) => {
      const wrapped = new Proxy({} as VaultTx, {
        get: (_target, prop) => {
          const repo: unknown = Reflect.get(tx, prop, tx);
          if (prop === 'now' || prop === 'scope' || typeof repo !== 'object' || repo === null) return repo;
          return new Proxy({}, {
            get: (_repository, method) => {
              const value: unknown = Reflect.get(repo, method, repo);
              if (typeof value !== 'function') return value;
              return async (...args: unknown[]) => {
                const call: RecordingStore['calls'][number] = { repo: String(prop), method: String(method), args: structuredClone(args) };
                this.calls.push(call);
                try {
                  this.beforeCall?.(String(prop), String(method));
                  const result: unknown = await Reflect.apply(value, repo, args);
                  call.result = structuredClone(result);
                  return result;
                } catch (error) {
                  call.error = error instanceof Error ? error.message : 'unknown error';
                  throw error;
                }
              };
            },
          });
        },
      });
      return fn(wrapped);
    });
  }

  health() { return this.inner.health(); }
  close() { return this.inner.close(); }
}
