import type { FacadeDeps } from '../../deps.js';
import type { HandlerRegistry } from '../../registry.js';
import {
  W2SpaceFoldersService,
  type W2SpaceFoldersServiceOptions,
} from '../../services/w2/space-folders.js';

export function registerW2SpaceFolderHandlers(
  registry: HandlerRegistry,
  deps: FacadeDeps,
  options: W2SpaceFoldersServiceOptions,
): void {
  const service = new W2SpaceFoldersService(deps, options);
  registry.registerAll({
    'spaceFolders.list': service.list,
    'spaceFolders.create': service.create,
    'spaceFolders.uploadInit': service.uploadInit,
    'spaceFolders.ingest': service.ingest,
    'spaceFolders.browse': service.browse,
    'spaceFolders.read': service.read,
  });
}
