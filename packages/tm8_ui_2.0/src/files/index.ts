/**
 * T3-4 FILES + T3-5 NODE ROOM — the module's public face.
 *
 * The stylesheets are imported HERE, not in `main.tsx`, so this surface is
 * self-contained: a host that mounts `FilesScreen` or `NodeRoom` gets its
 * styling by importing the component, with no second edit in a file it may
 * not own. Precedent: `panels/index.ts`, `auth/index.ts`.
 *
 * `honesty.css` comes from `panels/` because these screens use that lane's
 * `DisabledAction` / `HollowInline` treatments unchanged — importing another
 * lane's stylesheet, never editing it.
 */
import '../styles/tokens.css';
import '../styles/canvas-extra.css';
import '../panels/honesty/honesty.css';
import '../kit/kit.css';
import './files.css';

/* ── T3-4 ──────────────────────────────────────────────────────────────── */
export {
  FilesScreen,
  FileChip,
  DownloadControl,
  PreviewOverlay,
  type DownloadHref,
  type FilesScreenProps,
  type MessageBubble,
} from './FilesScreen';

/* ── T3-5 ──────────────────────────────────────────────────────────────── */
export { NodeRoom, useNodeFacts, connectionRow, type NodeRoomProps, type ProviderRow } from './NodeRoom';

/* ── the attachment strip: files on ONE entity, inside its panel body ───── */
export { AttachmentStrip, canThumbnail, type AttachmentStripProps } from './AttachmentStrip';
/* The attachments UNDER A MESSAGE — a different fact from the strip's "files
   on this entity", and shared by both chat surfaces. See the component header
   for why it is this lane's and not either surface's. */
export { MessageAttachments, type MessageAttachmentsProps } from './MessageAttachments';
/* The picker markup, shared by every surface that adopted the rich input —
   see the component's header for why this lane owns it. */
export { ChooseFilesControl } from './ChooseFilesControl';
export { ProjectFolderPicker, type ProjectFolderPickerProps } from './ProjectFolderPicker';
export {
  createFileUploadTask,
  safeUploadReason,
  sha256Hex,
  UploadCancelledError,
  type FileUploadTask,
  type FileUploadTaskOptions,
  type UploadedFile,
} from './upload';

/* ── the seam adapter (the ONLY place this lane touches a seam) ─────────── */
export {
  attachmentsFor,
  attachmentsPortFromSeam,
  type AttachmentsPort,
  type ProjectFolderPort,
  type ProjectFolderAttachInput,
  filesPortFromSeam,
  nodePortFromSeam,
  staticNodePort,
  fileKindRef,
  type FilesPort,
  type NodePort,
  type NodeFacts,
  type MessageWithFiles,
} from './port';

/* ── the model, exported so a host can build rows without re-deriving ───── */
export {
  attachedFiles,
  capSentence,
  enrich,
  extensionOf,
  failureWord,
  formatSizeChip,
  formatSizeRow,
  glyphFor,
  previewKindOf,
  rowFromAttachment,
  rowFromEntity,
  ATTACHED_TO,
  type FileFailure,
  type FileGlyph,
  type FileRow,
  type PreviewKind,
  type UploadItem,
} from './model';

/* ── the gap ledger — the list the coordinator hands upward ─────────────── */
export { ALL_FILES_NODE_REASONS, MISSING_FILE_OPS } from './reasons';

/** DEV-ONLY review surface — both frames, both themes, annotations on. */
export { FilesNodeBoard, FilesNodeBoardBothThemes } from './FilesNodeBoard';
