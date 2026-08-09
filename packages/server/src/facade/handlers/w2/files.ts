import type { FacadeDeps } from '../../deps.js';
import type { HandlerRegistry } from '../../registry.js';
import {
  W2FilesService,
  type W2FilesServiceOptions,
} from '../../services/w2/files.js';
import { W2ProjectFilesService } from '../../services/w2/project-files.js';

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
  // The browser reads the node's REAL filesystem and shares nothing with the
  // blob lifecycle above — no upload slot, no blob store, no entity. It is a
  // separate service so neither can weaken the other (FILES-DESIGN §3).
  const projectFiles = new W2ProjectFilesService(deps);
  registry.registerAll({
    'files.uploadInit': service.uploadInit,
    'files.uploadComplete': service.uploadComplete,
    'files.uploadAbort': service.uploadAbort,
    'files.download': service.download,
    'files.browse': projectFiles.browse,
    'files.read': projectFiles.read,
  });
}
