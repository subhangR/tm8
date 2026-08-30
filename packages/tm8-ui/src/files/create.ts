/**
 * THE FILE CREATE ACTION — pick, then upload, then the entity exists.
 *
 * This is `FileUploadCreateControl`'s body with the button taken off it, and
 * the reason it had to come off is the shape of the second caller. The list
 * root header (`panels/ListRootHeader`) OWNS its ＋ button and takes an
 * `onCreate` callback; it cannot host somebody else's `<button>`. So the
 * header needed the ACTION, and the only two ways to give it one were to
 * duplicate the pick-and-upload flow beside `birthFor` or to lift it here.
 *
 * Duplicating it would have split the create door in half: the panel's button
 * and the header's ＋ would each own a copy of the same lifecycle, and they
 * would diverge on the FAILURE path — the one nobody exercises by hand — which
 * is exactly the argument `upload.ts` already records for why the grant
 * lifecycle was lifted out of the chat lane rather than copied.
 *
 * WHY THE FILE LANE AND NOT `authoring/`: the same §15.2 reason `pick.ts`
 * gives. The authoring lane may contain no kind string literal, and this
 * function's whole job is to reach the picker, which is `<input type="file">`.
 * The file lane is where opening a file picker belongs.
 *
 * NO PLACEHOLDER STEP. An entity whose whole substance is its bytes cannot be
 * created before the bytes exist. The picker opens, the upload runs, and the
 * entity appears only once the node has actually stored something. If a file
 * is picked and the upload fails, NOTHING is created — the opposite of the
 * generic immediate-create, which committed an "Untitled file" whose
 * `create_file_entity` row carries `size_bytes 0`, a null checksum and a
 * `storage_path` no blob was ever written to.
 */
import type { CommandResult, EntityId, SpaceId } from '@tm8/contract';
import type { Seam } from '../data/seam';
import { pickFiles } from './pick';
import { createFileUploadTask, safeUploadReason } from './upload';

export interface FileUploadCreateOptions {
  /** The seam's file group, by TYPE — this lane constructs no seam. */
  files: Seam['files'];
  spaceId: SpaceId;
  /**
   * The finished entity, with THE UPLOAD'S OWN `CommandResult`.
   *
   * Not a fabricated `{patches: []}`. `upload.ts` carries `result` for exactly
   * this caller and says why: a caller that creates an entity this way must
   * reconcile it into its store, and an empty patch set tells the store
   * nothing — so the caller then selects, or navigates to, an id the store has
   * never been told about. That is a blank panel over a file that uploaded
   * perfectly well.
   */
  onCreated?: (id: EntityId, result: CommandResult) => void;
  /** One line per failed file, already stripped to a safe reason. */
  onNotice?: (text: string) => void;
  /**
   * Called `+n` when n files start and `-1` as each one settles, so a caller
   * with somewhere to put it can render progress. A caller with nowhere — the
   * root header's ＋, whose button belongs to another lane — omits it, and the
   * upload behaves identically.
   */
  onPending?: (delta: number) => void;
}

/**
 * Opens the picker and uploads everything chosen. Resolves when every upload
 * has settled, so a caller may await the whole batch; the per-file `onCreated`
 * and `onNotice` fire as each one lands, and are not held back for the batch.
 *
 * A cancelled picker resolves immediately, having done nothing — no notice,
 * because dismissing a dialog is not a failure to report.
 */
export async function runFileUploadCreate({
  files,
  spaceId,
  onCreated,
  onNotice,
  onPending,
}: FileUploadCreateOptions): Promise<void> {
  const picked = await pickFiles({ multiple: true });
  if (picked.length === 0) return;
  onPending?.(picked.length);
  await Promise.all(
    picked.map(async (file) => {
      const task = createFileUploadTask({ files, file, spaceId });
      try {
        const uploaded = await task.result;
        // The id comes from the COMPLETED upload, so a caller that navigates
        // to it is navigating to something with bytes behind it.
        onCreated?.(uploaded.fileEntityId, uploaded.result);
      } catch (error: unknown) {
        onNotice?.(`${file.name}: ${safeUploadReason(error)}`);
      } finally {
        onPending?.(-1);
      }
    }),
  );
}
