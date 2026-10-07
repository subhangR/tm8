/**
 * DOC AUTHORING — the T5-3 edit surface.
 *
 * Everything in this directory is MOUNTABLE, not mounted. Nothing here is wired
 * into a screen: the coordinator holds the wiring seat, and `HANDOVER.md`
 * carries the exact props and the exact mount points.
 *
 * The stylesheet is imported HERE rather than by each component, so a host that
 * imports one symbol gets the whole vocabulary and cannot end up with a
 * half-styled control. (`kit/index.ts`, `panels/index.ts` and
 * `authoring/index.ts` all do the same.)
 */
import './doc-edit.css';
import './doc-print.css';

export {
  docBodyOf,
  docCodec,
  docFormatOf,
  docPatchInput,
  savedVersionOf,
  type DocCommands,
  type DocEdits,
  type SaveCodec,
} from './commands';

export {
  blockLabel,
  blocksIn,
  isDiagram,
  readDraft,
  type DocBlock,
  type DocSegment,
} from './blocks';

export {
  AUTOSAVE_DELAY_MS,
  useDocSave,
  type DocSaveHandle,
  type DocSaveOptions,
  type DocSavePhase,
} from './useDocSave';

export {
  ConflictBanner,
  RefusalHost,
  SaveActions,
  SaveWord,
  StanceToggle,
  saveWordOf,
  type DocStance,
} from './EditorChrome';

export { BlockEditorSlot } from './BlockEditorSlot';
export { DocEditor } from './DocEditor';
export { DocPreview } from './DocPreview';
export { DocSource, type DocAttach } from './DocSource';
export { DocSplitView } from './DocSplitView';
export { RichBody, slashItems, type SlashItem } from './rich/RichBody';
export { RichDocView } from './rich/RichDocView';
export { encodeMinimal, reserialise, richExtensions, roundTrips } from './rich/markdown';
export { BODY_FIELD, DocTitleField } from './DocTitleField';
export { clearLiveTitle, setLiveTitle, useLiveTitle } from './liveTitles';
export {
  FRESH_DOC_TITLE,
  emptyFreshDocs,
  forgetFreshDoc,
  isEmptyDoc,
  isFreshArrival,
  isFreshDoc,
  isStillEmptyFreshDoc,
  freshDocTitle,
  markFreshDoc,
  noteFreshArrived,
  noteFreshDocEmpty,
} from './freshDocs';
export { clearLocalDraft, readLocalDraft, writeLocalDraft, type LocalDocDraft } from './localDraft';
export { DownloadDocControl } from './DownloadDocControl';
export { EditEntryControl } from './EditEntryControl';
export { canPrint, printDoc, PRINT_ROOT_ID, type PrintDocInput } from './printDoc';
export { fileReference, spliceInto } from './insert';
