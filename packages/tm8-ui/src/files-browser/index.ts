export { FilesScreen, type FilesScreenProps } from './FilesScreen';

/**
 * THE ARCHIVE ENCODER IS SHARED SURFACE. Lane D's Space-creation upload
 * consumes the SAME store-only ZIP writer this screen uses, so the repository
 * has one encoder with one path policy and one CRC implementation rather than
 * two that agree until they do not.
 */
export {
  ZIP_MAX_ENTRIES,
  ZIP_MAX_NAME_BYTES,
  ZIP_MAX_TOTAL_BYTES,
  ZipInvalidPathError,
  ZipTooLargeError,
  buildStoreOnlyZip,
  crc32,
  rejectArchivePath,
  safeArchivePath,
  zipBlob,
  type ArchivePathRejection,
  type ZipEntry,
} from './zip';

export {
  SKIP_REASON_TEXT,
  UploadCancelled,
  byteLabel,
  countLabel,
  packFolder,
  type PackProgress,
  type PackedFolder,
} from './archive';

export {
  folderFromDataTransfer,
  folderFromInput,
  totalBytesOf,
  type PickedFile,
  type PickedFolder,
} from './picked-folder';

export type {
  SpaceFolderSummary,
  SpaceFolderUploadResult,
  SpaceFoldersPort,
} from './space-folders';
