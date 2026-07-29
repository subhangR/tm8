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

/* ── the seam adapter (the ONLY place this lane touches a seam) ─────────── */
export {
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
