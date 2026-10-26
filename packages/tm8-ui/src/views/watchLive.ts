import type { CommandResult, EntityDetail, EntityId } from '@tm8/contract';
import type { Seam } from '../data/seam';

/**
 * The executor behind `LiveScreenButton` ("◉ Watch live"), shared by every
 * host that mounts a detail panel.
 *
 * Puts the task's live command on the viewer's clipboard, starts a vanilla
 * terminal in the task's space, and opens it. The terminal is titled with what
 * to do next, because the clipboard is invisible. The command is never sent to
 * the terminal: see `LiveScreenButton` for why.
 */
export function watchLiveFor(
  seam: Pick<Seam, 'commands'> | undefined,
  reconcileCommand: ((result: CommandResult) => void) | undefined,
  open: (id: EntityId) => void,
): ((detail: EntityDetail, command: string) => void) | undefined {
  const commands = seam?.commands;
  if (!commands) return undefined;
  return (detail, command) => {
    void navigator.clipboard?.writeText(command).catch(() => undefined);
    void commands
      .startTerminal({
        clientMutationId: `watch-live:${detail.id}:${Date.now()}`,
        spaceId: detail.spaceId,
        projectId: null,
        title: `Live: ${detail.title}`.slice(0, 120) + ' — paste (Ctrl+V), Enter',
      })
      .then((result) => {
        reconcileCommand?.(result);
        const id = (result as { entity?: { id?: string } }).entity?.id;
        if (id) open(id as EntityId);
      })
      .catch((error: unknown) => {
        console.warn('[tm8:watch-live] terminal did not start', error);
        window.alert(`Could not open a terminal: ${error instanceof Error ? error.message : String(error)}`);
      });
  };
}
