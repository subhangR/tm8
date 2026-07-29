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

export {
  docBodyOf,
  docFormatOf,
  docPatchInput,
  savedVersionOf,
  type DocCommands,
  type DocEdits,
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
export { DocSource } from './DocSource';
export { DocSplitView } from './DocSplitView';
export { EditEntryControl } from './EditEntryControl';
