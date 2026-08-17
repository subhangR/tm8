import type { FacadeDeps } from '../../deps.js';
import type { HandlerRegistry } from '../../registry.js';
import {
  W2ProjectFilesService,
  type W2ProjectFilesServiceOptions,
} from '../../services/w2/project-files-service.js';
import { W2ProjectFolderUploadService } from '../../services/w2/project-folder-upload-service.js';

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
  // The import half. It belongs here for the same reason: it drives the blob
  // store as its transport, so a deployment without file storage must answer
  // 501 rather than offer an upload that has nowhere to stage bytes.
  const folders = new W2ProjectFolderUploadService(deps, options);
  registry.registerAll({
    'projects.files.list': service.listFiles,
    // The viewer half — same jail, same authorization, mints nothing.
    'projects.files.read': service.readFile,
    'projects.files.attach': service.attachFile,
    'projects.folderUploads.init': folders.init,
    'projects.folderUploads.complete': folders.complete,
    'projects.folderUploads.abort': folders.abort,
  });
}
