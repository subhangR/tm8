/**
 * `@tm8/client-core/project` — the per-family event reducers and the optimistic
 * journal keyed by `clientMutationId` (s-lld §2, §6). The test builders are a
 * separate subpath, `@tm8/client-core/project/test-support`.
 */
export * from './reducers';
export * from './journal';
