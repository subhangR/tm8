/**
 * THE PANEL ACTION BAR'S EXECUTOR — what `edit` and `add-child` actually do.
 *
 * WHY A HOOK IN `views/` AND NOT LOGIC IN THE PANEL, which is the same argument
 * `useRowLifecycle` makes and for the same reason: `EntityDetailPanel` never
 * taps the seam. It decides WHAT was asked for — a verb id, from registry data
 * — and the host decides what that MEANS as a seam call. That is what lets one
 * panel render against the fixture seam, the real seam and a test double.
 *
 * THE TWO VERBS, AND WHY THEY WERE BOTH DEAD UNTIL NOW.
 *
 *   edit       → `commands.patchEntity`, through the `editFields` dialog. The
 *                verb is new; nothing could have wired it.
 *   add-child  → `commands.createEntity` with `parentId` set to the open
 *                entity. This one has EXISTED, on `doc` and `channel`, since
 *                the registry rows were written — and it rendered
 *                disabled-with-reason on every panel in the app for the whole
 *                time, because no host ever passed an `onAction` at all. The
 *                graph was always ready: `entities.parentId` is kind-agnostic
 *                and `channel`'s row already declares `tree: { by: 'hierarchy' }`.
 *                So subchannels were a wiring gap, not a schema one.
 *
 * `wiredActions` IS DERIVED FROM THE HANDLER MAP, NEVER TYPED OUT TWICE. The
 * action bar draws a verb it cannot dispatch as disabled-with-reason, and the
 * only way that stays true as verbs are added is for the advertised set and
 * the implemented set to be the same object. A verb added to `VERBS` below is
 * live; one removed goes back to being honestly disabled.
 */
import { useCallback, useMemo } from 'react';
import type { EntityDetail, EntityId, SpaceId } from '@tm8/contract';
import {
  editsFrom,
  fieldKey,
  useEntityEdit,
  useNewTask,
  placeholderTitleFor,
  type AuthoringCommands,
  type DialogField,
  type EntityEditHandle,
  type NewTaskHandle,
} from '../authoring';
import { getKind, placeholderNameFor, titleNormalizerFor, type ActionRef, type KindConfig } from '../domain';

/**
 * EVERY VERB THIS HOOK CAN PERFORM — the second panel dispatcher's counterpart
 * to `PANEL_PRIMARY_ACTIONS`, so a guard can ask "does any executor cover this
 * primary?" without knowing which lane wrote it. The per-subject `wiredActions`
 * below is a SUBSET of this: `edit` drops out on a kind with no `editFields`.
 * Pinned to the handler map by `entity-verbs.test.tsx`, so the two cannot drift.
 */
export const ENTITY_VERB_ACTIONS: readonly ActionRef[] = ['edit', 'add-child'];

export interface EntityVerbsHandle {
  /** Pass to `EntityDetailPanel.onAction`. */
  onAction(ref: ActionRef): void;
  /** Pass to `EntityDetailPanel.wiredActions`. Derived, never restated. */
  wiredActions: readonly ActionRef[];
  /** The open dialog's flow, or null when the subject declares no `editFields`. */
  edit: EntityEditHandle;
  /** The dialog's resolved fields, in registry order. */
  editFields: readonly DialogField[];
  /** "Edit channel" — the registry's own label, never a literal. */
  editTitle: string;
  /** The subchannel/child create flow. */
  addChild: NewTaskHandle;
}

export interface EntityVerbsOptions {
  detail: EntityDetail | null | undefined;
  spaceId: SpaceId;
  /** Null ⇒ nothing is wired, and every verb says so rather than looking live. */
  commands: AuthoringCommands | null;
  /** The coordinator opens the new child, exactly as `＋ New` opens a new root. */
  onCreated?(id: EntityId): void;
  /**
   * RE-READ THE DETAIL AFTER A SAVE, and it is not optional polish.
   *
   * A command echo carries the SUMMARY (`entity.upsert`), so a renamed channel
   * updates its header the instant the patch lands — the header reads the
   * summary. `topic` lives in the DETAIL, which nothing re-reads on its own, so
   * without this the dialog closes cleanly on a successful save and the hub
   * body still shows the old topic. Measured in Firefox against the fixture
   * seam: header `design-review` (new) beside description `tm8-ui build` (old),
   * which is the worst of both — it looks like the save half-worked.
   */
  onSaved?(id: EntityId): void;
}

export function useEntityVerbs(options: EntityVerbsOptions): EntityVerbsHandle {
  const { detail, spaceId, commands, onCreated, onSaved } = options;

  /**
   * THE SUBJECT'S OWN KIND, not the list's.
   *
   * A panel opened from a task list can be showing a channel — the peek stack
   * drills into whatever was clicked. Resolving the config from `detail.kind`
   * is what makes the dialog offer the fields of the thing on screen rather
   * than the fields of the collection it was reached through.
   */
  const config: KindConfig | null = detail ? getKind(detail.kind) : null;

  const editFields = useMemo<readonly DialogField[]>(() => {
    if (!config?.editFields) return [];
    return config.editFields.map((field) => ({
      target: field.target,
      source: field.source,
      label: field.label,
      required: field.required,
      placeholder: field.placeholder,
      multiline: field.multiline,
      /*
       * The grammar is resolved HERE because `titleNormalizerFor` reads a
       * `KindConfig`, and `src/authoring/` may not hold one — the dialog takes
       * a plain function and stays kind-agnostic (§15.2).
       */
      normalize: field.grammar ? titleNormalizerFor({ titleGrammar: field.grammar }) : undefined,
    }));
  }, [config?.editFields]);

  const edit = useEntityEdit({
    detail,
    commands,
    onSaved: () => { if (detail) onSaved?.(detail.id); },
  });

  /**
   * A CHILD IS THE SAME KIND AS ITS PARENT. `add-child` on a channel makes a
   * channel; on a doc, a doc. That is what the verb has always meant on the two
   * rows that declare it, and it is what makes subchannels fall out of the
   * existing hierarchy rather than needing a kind picker nobody asked for.
   *
   * The kind falls back to the parent's own when there is no subject, which
   * only ever happens while `detail` is loading — the verb is not in the map
   * then anyway, so the fallback is never dispatched, and `useNewTask` needs a
   * kind to compute its refusal from.
   */
  const addChild = useNewTask({
    spaceId,
    kind: detail?.kind ?? 'task',
    parentId: detail?.id ?? null,
    placeholderTitle: config
      ? placeholderNameFor(config, placeholderTitleFor(config.label))
      : '',
    commands,
    onCreated: (id) => onCreated?.(id),
  });

  /**
   * The draft is seeded from the entity AS IT STANDS WHEN THE DIALOG OPENS,
   * not from a memo that could be a render behind. `editsFrom` is the inverse
   * of this projection and they are tested against each other, so a field that
   * reads from one place and writes to another cannot pass silently.
   */
  const openEdit = useCallback(() => {
    if (!detail) return;
    const content = (detail.content ?? {}) as Record<string, unknown>;
    const seed: Record<string, string> = {};
    for (const field of editFields) {
      const raw = field.target === 'title' ? detail.title : content[field.source ?? ''];
      seed[fieldKey(field)] = typeof raw === 'string' ? raw : '';
    }
    edit.begin(seed);
  }, [detail, edit, editFields]);

  /**
   * ONE MAP, AND IT IS BOTH THE DISPATCH AND THE ADVERTISEMENT. A verb absent
   * here renders disabled-with-reason in the bar; there is no third state in
   * which it looks live and does nothing.
   *
   * `edit` is omitted when the kind declares no fields: a dialog with nothing
   * in it is not an edit surface, and offering the verb anyway would be the
   * same empty promise from a different direction.
   */
  const verbs = useMemo<Partial<Record<ActionRef, () => void>>>(() => {
    const map: Partial<Record<ActionRef, () => void>> = {};
    if (editFields.length > 0) map.edit = openEdit;
    if (detail) map['add-child'] = () => void addChild.create();
    return map;
  }, [addChild, detail, editFields.length, openEdit]);

  const wiredActions = useMemo(() => Object.keys(verbs) as ActionRef[], [verbs]);

  const onAction = useCallback((ref: ActionRef) => verbs[ref]?.(), [verbs]);

  return {
    onAction,
    wiredActions,
    edit,
    editFields,
    editTitle: config ? `Edit ${config.label.toLowerCase()}` : 'Edit',
    addChild,
  };
}

/** Re-exported so a host can assert the projection without reaching into the lane. */
export { editsFrom };
