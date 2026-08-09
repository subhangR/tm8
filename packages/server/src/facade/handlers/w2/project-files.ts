import type { FacadeDeps } from '../../deps.js';
import type { HandlerRegistry } from '../../registry.js';
import {
  W2ProjectFilesService,
  type W2ProjectFilesServiceOptions,
} from '../../services/w2/project-files-service.js';

/**
 * Reading a connected project folder is registered with the file lane, not the
 * project lane, because both operations need the blob store: the listing
 * reports the deployment's byte ceiling and the attach writes through it. A
 * deployment configured without file storage therefore answers an honest 501
 * for these rather than offering a browser that cannot attach anything.
 */
export function registerW2ProjectFilesHandlers(
  registry: HandlerRegistry,
  deps: FacadeDeps,
  options: W2ProjectFilesServiceOptions,
): void {
  const service = new W2ProjectFilesService(deps, options);
  registry.registerAll({
    'projects.files.list': service.listFiles,
    'projects.files.read': service.readFile,
    'projects.files.attach': service.attachFile,
  });
}
