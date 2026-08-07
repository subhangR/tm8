import type { ReactNode } from 'react';
import type { EntityDetail, EntityId, SpaceId } from '@tm8/contract';
import { EditEntityDialog, type AuthoringCommands } from '../authoring';
import { useEntityVerbs, type EntityVerbsHandle } from './useEntityVerbs';

/**
 * `useEntityVerbs` AS A COMPONENT, because one host cannot call it as a hook.
 *
 * `WorkspaceView.renderPanel` is a `useCallback` that renders a panel PER ID —
 * the workspace shows a pinned column and a stack at the same time, so there
 * are two or more subjects on screen and no fixed number of them. A hook
 * called inside that callback would be a hook called conditionally and in a
 * loop, which is the one thing React forbids outright.
 *
 * A render-prop child is the ordinary answer: every `<EntityVerbs>` element is
 * its own component instance, so each panel gets its own dialog state and its
 * own draft, and a conflict on the pinned channel does not blow away what was
 * being typed in the stack. `EntityView` calls the hook directly because it has
 * exactly one subject and needs no such thing.
 *
 * THE DIALOG IS MOUNTED HERE, beside the children rather than inside them: it
 * is `position: fixed` over a scrim, and nesting it in the panel's own
 * overflow context would clip the sheet against the column it covers.
 */
export function EntityVerbs({
  detail,
  spaceId,
  commands,
  onCreated,
  onSaved,
  children,
}: {
  detail: EntityDetail | null | undefined;
  spaceId: SpaceId;
  commands: AuthoringCommands | null;
  onCreated?: (id: EntityId) => void;
  onSaved?: (id: EntityId) => void;
  children: (verbs: EntityVerbsHandle) => ReactNode;
}) {
  const verbs = useEntityVerbs({
    detail,
    spaceId,
    commands,
    ...(onCreated ? { onCreated } : {}),
    ...(onSaved ? { onSaved } : {}),
  });
  return (
    <>
      <EditEntityDialog flow={verbs.edit} fields={verbs.editFields} title={verbs.editTitle} />
      {children(verbs)}
    </>
  );
}
