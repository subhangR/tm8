import type { FacadeDeps } from '../../deps.js';
import type { HandlerRegistry } from '../../registry.js';
import {
  W2FilesService,
  type W2FilesServiceOptions,
} from '../../services/w2/files.js';

/**
 * W2.G07's complete semantic-catalog registration seam.
 *
 * The raw PUT support path is intentionally absent from this registry: it is
 * transport for a FileUploadGrant, not a catalog operation. Integration mounts
 * the separate `createW2FileUploadRoute` seam before the JSON body reader.
 */
export function registerW2FileHandlers(
  registry: HandlerRegistry,
  deps: FacadeDeps,
  options: W2FilesServiceOptions,
): void {
  const service = new W2FilesService(deps, options);
  registry.registerAll({
    'files.uploadInit': service.uploadInit,
    'files.uploadComplete': service.uploadComplete,
    'files.uploadAbort': service.uploadAbort,
    'files.download': service.download,
  });
}
