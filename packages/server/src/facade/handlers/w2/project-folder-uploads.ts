import type { FacadeDeps } from '../../deps.js';
import type { HandlerRegistry } from '../../registry.js';
import {
  W2ProjectFolderUploadService,
  type W2ProjectFolderUploadServiceOptions,
} from '../../services/w2/project-folder-uploads.js';

export type W2ProjectFolderUploadHandlerDeps = W2ProjectFolderUploadServiceOptions;

/**
 * projects.folderUploads.* registration seam.
 *
 * Bytes ride the EXISTING raw PUT support path (`createW2FileUploadRoute`):
 * every grant this family issues is an ordinary file-upload slot, so no new
 * transport route exists to discover.
 */
export function registerW2ProjectFolderUploadHandlers(
  registry: HandlerRegistry,
  deps: FacadeDeps,
  options: W2ProjectFolderUploadServiceOptions,
): void {
  const service = new W2ProjectFolderUploadService(deps, options);
  registry.registerAll({
    'projects.folderUploads.init': service.init,
    'projects.folderUploads.complete': service.complete,
    'projects.folderUploads.abort': service.abort,
  });
}
