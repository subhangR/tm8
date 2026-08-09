/** Public face of the Files explorer. Imports its own stylesheet so a host
 * needs no second edit. */
import './files-explorer.css';

export { FilesExplorerScreen, breadcrumbSegments, formatSize } from './FilesExplorerScreen';
export {
  EXPLORER_REASONS,
  LIBRARY_ROOT_ID,
  filesExplorerPortFromSeam,
  type ExplorerEntry,
  type ExplorerListing,
  type ExplorerRoot,
  type ExplorerRootKind,
  type ExplorerFolderImport,
  type ExplorerUploadCapability,
  type FilesExplorerPort,
} from './port';
export { createUploadQueue, type UploadQueue, type UploadQueueItem, type UploadQueueSnapshot } from './upload-queue';
export {
  directoryEntries,
  startFolderImport,
  type FolderImportOutcome,
  type FolderImportTask,
} from './folder-import';
export {
  filesFromDataTransfer,
  filesFromInput,
  findConflicts,
  keepBothName,
  refuseReason,
  resolveConflicts,
  type ConflictChoice,
  type PickedFile,
  type PickResult,
} from './picker';
