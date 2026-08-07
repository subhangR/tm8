/**
 * AUTHORING — the new-task flow and the save flow.
 *
 * Everything in this directory is MOUNTABLE, not mounted. Nothing here is
 * wired into a screen: the coordinator holds the wiring seat, and
 * `HANDOVER-Authoring.md` carries the exact props and the exact call sites.
 *
 * The stylesheet is imported HERE rather than by each component, so a host
 * that imports one symbol gets the whole vocabulary and cannot end up with a
 * half-styled control. (`kit/index.ts` and `panels/index.ts` do the same.)
 */
import './authoring.css';

export {
  classifyFailure,
  createdIdOf,
  entityPatchInput,
  newEntityInput,
  newTaskInput,
  nextMutationId,
  placeholderTitleFor,
  taskPatchInput,
  type AuthoringCommands,
  type CreateEntityCommands,
  type CreateTitle,
  type AuthoringFailure,
  type ConflictFailure,
  type RefusedFailure,
  type TaskEdits,
} from './commands';

export { useNewTask, type NewTaskHandle, type NewTaskOptions, type NewTaskPhase } from './useNewTask';
export {
  useTaskSave,
  type SavePhase,
  type TaskSaveHandle,
  type TaskSaveOptions,
  type UnavailableReason,
} from './useTaskSave';

export { InlineTitleEditor } from './InlineTitleEditor';
export { NewTaskControl } from './NewTaskControl';
export { RefusalCard, type RefusalMove } from './RefusalCard';
export { AuthoringHost, SaveControls } from './SaveControls';
export { StatusSelect, type StatusOption } from './StatusSelect';
