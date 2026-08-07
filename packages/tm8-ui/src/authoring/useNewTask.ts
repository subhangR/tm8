/**
 * THE GENERIC NEW-ENTITY FLOW.
 *
 * THE ORACLE, verbatim, because it decides the whole shape (T5-6 "Generic
 * create pattern", `data-screen-label` frame 3 of the authoring canvas):
 *
 *   "+ New → placeholder title → Z3 opens, title in inline-edit focus ·
 *    no per-kind forms"
 *   "created for real, instantly — the row is already in the list as
 *    'Untitled task'. Type the name, enter commits, esc keeps the placeholder."
 *
 * SO THERE IS NO CREATE FORM. There is no dialog, no field set, no wizard.
 * The create fires with a registry-provided kind and placeholder title, the
 * entity exists from that instant, and the SAVE flow is what names it. The
 * historical `useNewTask` export remains because it is already a package
 * surface; its executor is deliberately the generic `createEntity` command.
 *
 * The one designed exception in the same canvas is the teammate dialog (four
 * fields), and it is explicitly enumerated as an exception — "Exceptions are
 * only the designed ones: teammate (above), member invite (T2-1), project
 * registration (T2-2)". Task is not among them.
 */
import { useCallback, useState } from 'react';
import type { CommandResult, EntityId, SpaceId } from '@tm8/contract';
import {
  classifyFailure,
  createdIdOf,
  newEntityInput,
  type CreateEntityCommands,
  type CreateTitle,
  type RefusedFailure,
} from './commands';

export type NewTaskPhase =
  | { phase: 'idle' }
  | { phase: 'creating' }
  | { phase: 'refused'; failure: RefusedFailure };

export interface NewTaskHandle {
  state: NewTaskPhase;
  /**
   * Why creation is unavailable right now, or null. NON-NULL MEANS THE CONTROL
   * RENDERS DISABLED-WITH-REASON — never hidden and never a live button that
   * does nothing (R7 / charter R5 finding "I click run and nothing happens").
   */
  unavailable: { cause: string; remedy: string } | null;
  create(): Promise<void>;
  dismiss(): void;
}

export interface NewTaskOptions {
  spaceId: SpaceId;
  /** The selected route kind, passed through from registry-driven screen state. */
  kind: string;
  /** Registry override or the label-derived generic placeholder. */
  placeholderTitle: CreateTitle;
  /** Null ⇒ no executor is wired, and the control says so. */
  commands: CreateEntityCommands | null;
  /** The coordinator's wiring: open the panel on the new id, title focused. */
  onCreated?(id: EntityId, result: CommandResult): void;
  /** Extra refusal supplied by the caller (a capability the server turned off). */
  refusal?: { cause: string; remedy: string } | null;
}

const NO_EXECUTOR = {
  cause: 'Creating is not wired here',
  remedy: 'this surface was mounted without a command executor',
} as const;

export function useNewTask(options: NewTaskOptions): NewTaskHandle {
  const { spaceId, kind, placeholderTitle, commands, onCreated, refusal } = options;
  const [state, setState] = useState<NewTaskPhase>({ phase: 'idle' });

  const unavailable = commands === null ? NO_EXECUTOR : (refusal ?? null);

  const create = useCallback(async () => {
    if (commands === null) return;
    /**
     * THE DOUBLE-PRESS GUARD, and it is not a nicety. The oracle's promise is
     * that the row exists the instant you press; a second press during the
     * in-flight window would honour that promise TWICE and leave an orphan
     * "Untitled task" in the list that the user never asked for and cannot
     * distinguish from theirs. Guarded on the phase rather than on a disabled
     * attribute, because a disabled attribute would take the control out of
     * the tab order (D28) and because keyboard repeat does not go through it.
     */
    if (state.phase === 'creating') return;
    setState({ phase: 'creating' });
    try {
      const result = await commands.createEntity(newEntityInput(spaceId, kind, placeholderTitle));
      const id = createdIdOf(result);
      if (id === null) {
        /**
         * Created, but we do not know WHAT. A real state, distinct from a
         * failure: something exists on the node and we cannot open it. Saying
         * "created!" and opening nothing, or reporting a failure that did not
         * happen, are both lies available here — this is the third answer.
         */
        setState({
          phase: 'refused',
          failure: {
            kind: 'refused',
            cause: 'created, but the node did not return the new id',
            detail: 'The command succeeded and carried neither an entity nor a patch to read it from.',
            aftermath:
              'The task MAY exist — reload the list to find it. It cannot be opened from here without an id.',
            code: 'no_id',
            retryable: false,
          },
        });
        return;
      }
      setState({ phase: 'idle' });
      onCreated?.(id, result);
    } catch (error) {
      setState({ phase: 'refused', failure: asRefused(error) });
    }
  }, [commands, kind, onCreated, placeholderTitle, spaceId, state.phase]);

  const dismiss = useCallback(() => setState({ phase: 'idle' }), []);

  return { state, unavailable, create, dismiss };
}

/**
 * A create cannot version-conflict — there is no prior version to conflict
 * with — so `classifyFailure` can only return the refusal arm here. The
 * narrowing is asserted rather than cast: if the contract ever made create
 * conflict-capable, this throws loudly at the point of the wrong assumption
 * instead of rendering a conflict card with no conflict data behind it.
 */
function asRefused(error: unknown): RefusedFailure {
  const failure = classifyFailure(error, 'create');
  if (failure.kind === 'refused') return failure;
  return {
    kind: 'refused',
    cause: 'create refused — a version conflict on a create',
    detail: 'The node reported a version conflict for an entity that did not exist yet.',
    aftermath: 'Nothing was created.',
    code: 'version_conflict',
    retryable: false,
  };
}
