/**
 * THE STAGED CREATE DOOR, AS AN ACTION — for a header that owns its own button.
 *
 * `EntityCreateControl` answers "which create flow does this kind declare?" by
 * RENDERING one, and every surface that mounts it in a `createSlot` gets the
 * right door for free. `views/EntityView` is such a surface. The two ROOT
 * HEADERS are not: `panels/ListRootHeader` draws the ＋ itself and takes an
 * `onCreate` callback, so there is no slot to put a component in.
 *
 * That is how the defect got in. When the root header's ＋ was rewired to
 * drive `useNewTask` directly (task 01a0102f, owner ruling R4), `createForm`
 * routing went with the component that was removed, and nothing replaced it.
 * `birthFor` was left with two arms — start-the-kind, or the generic immediate
 * create — and the `file` kind fell into the second one. Pressing ＋ on Files
 * ran `entities.create`, whose `create_file_entity` RPC writes a `public.files`
 * row with `size_bytes 0`, a null checksum, and a `storage_path` that no blob
 * is ever written to. The row lists in the Files browser, offers a Download
 * link, and the download answers `not_found: no readable file`. ELEVEN such
 * rows exist across the node's three spaces.
 *
 * So this module is the same question asked in the other direction: not "what
 * do I render", but "what do I RUN". One function, so a header can carry a
 * staged create without carrying a component.
 *
 * IT COVERS `file-upload` AND NOT `scheduled-work`, and the difference is not
 * an oversight: a loop's create door is a DIALOG (`LoopCreateControl`) with
 * fields to fill in, and there is no headless action to hand a header. Loops
 * therefore still fall through to the generic create from a root header, as
 * they did before this change — an untouched behaviour, not a fixed one, and
 * named here so the next reader does not have to infer it from an absence.
 */
import type { CommandResult, EntityId, SpaceId } from '@tm8/contract';
import type { KindConfig } from '../domain';
import type { Seam } from '../data/seam';
import { runFileUploadCreate } from '../files/create';

export interface StagedBirthDeps {
  spaceId: SpaceId;
  /** Required for the same reason `EntityCreateControl` requires it: `files`
   *  is required on `Seam`, and an optional one here only manufactures a
   *  disabled state no wiring can reach. */
  files: Seam['files'];
  onCreated?: (id: EntityId, result: CommandResult) => void;
  onNotice?: (text: string) => void;
}

/**
 * The action this kind's declared create form runs, or `null` when the kind
 * declares none that can run without a form on screen.
 *
 * `null` is the caller's signal to keep its existing behaviour — it is NOT a
 * refusal, and a caller that turned it into one would refuse every ordinary
 * kind on the menu.
 */
export function stagedBirthFor(
  config: KindConfig,
  deps: StagedBirthDeps,
): (() => void) | null {
  if (config.createForm !== 'file-upload') return null;
  return () => {
    void runFileUploadCreate({
      files: deps.files,
      spaceId: deps.spaceId,
      ...(deps.onCreated ? { onCreated: deps.onCreated } : {}),
      ...(deps.onNotice ? { onNotice: deps.onNotice } : {}),
    });
  };
}
