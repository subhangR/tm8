/**
 * The HTTP frame: config, the catalog-driven router, the DEV-6 envelope and
 * DEV-8 error middleware, the security seam, and the serve-static seam.
 *
 * Nothing here knows what an entity is. Semantics arrive at W2 through the
 * handler registry in ../facade/.
 */
export { loadConfig, isLoopback, ConfigError, type ServerConfig } from './config.js';
export { nextRequestId } from './request-id.js';
export {
  SQLSTATE_TO_ERROR_CODE,
  errorCodeForSqlState,
  toWireError,
  sendWireError,
  fail,
  notImplemented,
  CollabError,
} from './errors.js';
export { readJsonBody, type ParsedBody } from './body.js';
export { Router, compileRoute, type CompiledRoute, type RouteMatch } from './router.js';
export {
  autoOwnerResolver,
  checkTransport,
  checkHost,
  checkOrigin,
  checkCsrf,
  BASE_SECURITY_HEADERS,
  type SecurityDecision,
} from './security.js';
export { createStaticHandler, type StaticHandler } from './static.js';
export {
  createFacadeServer,
  type FacadeServer,
  type FacadeServerOptions,
  type UpgradeTarget,
} from './server.js';
export {
  isHandlerResult,
  json,
  raw,
  type HandlerResult,
  type IdentityResolver,
  type JsonResult,
  type OperationHandler,
  type RawResult,
  type RequestContext,
  type RequestIdentity,
} from './types.js';
