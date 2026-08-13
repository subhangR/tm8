import type { CommandResult, EntityId, SpaceId } from '@tm8/contract';
import type { KindConfig } from '../domain';
import type { Seam } from '../data/seam';
import { LoopCreateControl } from '../loops/LoopCreateControl';
import type { AuthoringCommands } from './commands';
import { FileUploadCreateControl } from './FileUploadCreateControl';
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
  files,
  onCreated,
  onNotice,
}: {
  config: KindConfig;
  immediate: NewTaskHandle;
  spaceId: SpaceId;
  commands: AuthoringCommands | null;
  /**
   * Only the `file-upload` form needs it; every other kind ignores it. Not
   * optional: `files` is required on `Seam`, and letting it be undefined here
   * only manufactures an unreachable disabled state downstream.
   */
  files: Seam['files'];
  onCreated?: (id: EntityId, result: CommandResult) => void;
  onNotice?: (text: string) => void;
}) {
  const label = config.palette?.createLabel ?? '＋ New';
  if (config.createForm === 'file-upload') {
    // A kind whose substance IS its bytes cannot be created before them.
    return (
      <FileUploadCreateControl
        label={label}
        spaceId={spaceId}
        files={files}
        onCreated={onCreated}
        onNotice={onNotice}
      />
    );
  }
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
