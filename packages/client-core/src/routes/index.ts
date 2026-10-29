/**
 * `@tm8/client-core/routes` — the web address codec (s-lld §2, §3): parse,
 * build and normalize `#/s/<space>/…`, the `q=` codec, the redirects and the
 * memory router target. In the phone app it translates web links in and share
 * links out; it is not the app's router.
 */
export * from './codec';
export * from './q';
export * from './redirects';
export * from './types';
export * from './transport';
