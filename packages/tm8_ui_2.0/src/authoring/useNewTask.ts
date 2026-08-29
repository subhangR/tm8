/**
 * THE NEW-TASK FLOW.
 *
 * THE ORACLE, verbatim, because it decides the whole shape (T5-6 "Generic
 * create pattern", `data-screen-label` frame 3 of the authoring canvas):
 *
 *   "+ New → placeholder title → Z3 opens, title in inline-edit focus ·
 *    no per-kind forms"
 *   "created for real, instantly — the row is already in the list as
 *    'Untitled task'. Type the name, enter commits, esc keeps the placeholder."
 *
 * SO THERE IS NO CREATE FORM. There is no dialog, no field set, no wizard —
 * for a task there is nothing to fill in before committing. The create fires
 * with a placeholder title, the entity exists from that instant, and the SAVE
 * flow is what names it. That is why the two flows were assigned together:
 * they are one continuous flow with a seam-crossing in the middle.
 *
 * The one designed exception in the same canvas is the teammate dialog (four
 * fields), and it is explicitly enumerated as an exception — "Exceptions are
 * only the designed ones: teammate (above), member invite (T2-1), project
 * registration (T2-2)". Task is not among them.
 */
import { useCallback, useState } from 'react';
import type { CommandResult, EntityId, EntityKind, SpaceId } from '@tm8/contract';
import {
  classifyFailure,
  createdIdOf,
  creatableKind,
  newEntityInput,
  type AuthoringCommands,
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
  /**
   * The same question for a kind this flow is NOT bound to — what the root
   * header's menu asks, once per row.
   *
   * `unavailable` is exactly `unavailableFor(kind)`, so the two cannot drift.
   * The caller's own `refusal` is NOT applied here: it is a statement about
   * the bound kind ("sessions aren't created from here"), and answering it for
   * every other kind is how one refused row refuses fourteen. A caller that
   * has a per-kind refusal of its own supplies it beside this answer.
   */
  unavailableFor(kind: EntityKind): { cause: string; remedy: string } | null;
  /**
   * `target` OVERRIDES the bound kind for one create, and it exists for exactly
   * one caller: the root header's kind MENU, where every row carries its own ＋
   * and the row you press is almost never the kind the list is showing.
   *
   * The alternative was to switch the root first and create on the next render,
   * which cannot work — `kind` is host state, so the create in the same tick
   * would still make the OLD kind. It would have made "＋ on the Docs row"
   * create a task, which is the `createTask` defect this flow already fixed
   * once (see `commands.ts`'s docblock) coming back through the front door.
   *
   * Both members travel together on purpose: a kind with the previous kind's
   * placeholder is an "Untitled task" that is a doc.
   */
  create(target?: { kind: EntityKind; placeholderTitle: string }): Promise<void>;
  dismiss(): void;
}

export interface NewTaskOptions {
  spaceId: SpaceId;
  /**
   * The kind this surface lists, from its registry config. WITHOUT IT the flow
   * created a task on every surface, so "＋ New channel" made something the
   * channel list could not show.
   */
  kind: EntityKind;
  /**
   * The entity the new one hangs under, when this control is a CHILD-create
   * rather than a root-create. The `add-child` verb on an open entity passes
   * that entity's id; a list header's `＋ New` passes nothing.
   *
   * The graph makes no distinction — `parentId` is kind-agnostic — so one
   * flow serves both, and a channel created under a channel is a subchannel
   * with no second code path to keep in step with this one.
   */
  parentId?: EntityId | null;
  /** From the kind registry's `label` via `placeholderTitleFor` — never a literal. */
  placeholderTitle: string;
  /** Null ⇒ no executor is wired, and the control says so. */
  commands: AuthoringCommands | null;
  /** The coordinator's wiring: open the panel on the new id, title focused. */
  onCreated?(id: EntityId, result: CommandResult): void;
  /** Extra refusal supplied by the caller (a capability the server turned off). */
  refusal?: { cause: string; remedy: string } | null;
}

const NO_EXECUTOR = {
  cause: 'Creating is not wired here',
  remedy: 'this surface was mounted without a command executor',
} as const;

/**
 * A kind the generic create cannot make (see `creatableKind`). Disabled WITH
 * THE REASON rather than hidden, and rather than the old behavior of making a
 * task instead — which is the same lie, just quieter.
 */
const NOT_CREATABLE = {
  cause: 'These are not created here',
  remedy: 'this kind is made another way — a session by launching, a member by invitation',
} as const;

export function useNewTask(options: NewTaskOptions): NewTaskHandle {
  const { spaceId, kind, parentId, placeholderTitle, commands, onCreated, refusal } = options;
  const [state, setState] = useState<NewTaskPhase>({ phase: 'idle' });

  const creatable = creatableKind(kind);
  const unavailableFor = useCallback(
    (target: EntityKind) =>
      commands === null ? NO_EXECUTOR : creatableKind(target) === null ? NOT_CREATABLE : null,
    [commands],
  );
  const unavailable = unavailableFor(kind) ?? refusal ?? null;

  const create = useCallback(async (target?: { kind: EntityKind; placeholderTitle: string }) => {
    /* The TARGET's creatability, not the bound kind's — a menu row for a kind
       the generic create cannot make must refuse, whatever the list is on. */
    const madeKind = target ? creatableKind(target.kind) : creatable;
    const madeTitle = target ? target.placeholderTitle : placeholderTitle;
    if (commands === null || madeKind === null) return;
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
      const result = await commands.createEntity(
        newEntityInput(spaceId, madeKind, madeTitle, parentId),
      );
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
  }, [commands, creatable, onCreated, parentId, placeholderTitle, spaceId, state.phase]);

  const dismiss = useCallback(() => setState({ phase: 'idle' }), []);

  return { state, unavailable, unavailableFor, create, dismiss };
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
