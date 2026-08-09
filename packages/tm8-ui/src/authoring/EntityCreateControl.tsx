import type { CommandResult, EntityId, SpaceId } from '@tm8/contract';
import type { KindConfig } from '../domain';
import { LoopCreateControl } from '../loops/LoopCreateControl';
import type { AuthoringCommands } from './commands';
import { NewTaskControl } from './NewTaskControl';
import type { NewTaskHandle } from './useNewTask';

/**
 * The registry-selected create flow.
 *
 * Most kinds keep the immediate placeholder flow. A kind whose create door
 * requires content declares `createForm`; this component swaps in that staged
 * form without making the generic screen name the kind.
 */
export function EntityCreateControl({
  config,
  immediate,
  spaceId,
  commands,
  onCreated,
}: {
  config: KindConfig;
  immediate: NewTaskHandle;
  spaceId: SpaceId;
  commands: AuthoringCommands | null;
  onCreated?: (id: EntityId, result: CommandResult) => void;
}) {
  const label = config.palette?.createLabel ?? '＋ New';
  if (config.createForm === 'scheduled-work') {
    return (
      <LoopCreateControl
        spaceId={spaceId}
        commands={commands}
        label={label}
        onCreated={onCreated}
      />
    );
  }
  return <NewTaskControl flow={immediate} label={label} />;
}
