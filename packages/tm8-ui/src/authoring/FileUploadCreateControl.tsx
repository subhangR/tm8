/**
 * THE `file` KIND'S CREATE DOOR — an upload, because that is what the button
 * has always said.
 *
 * The `file` kind declared `palette: { createLabel: 'Upload file' }` and no
 * `createForm`, so `EntityCreateControl` fell through to the generic IMMEDIATE
 * flow: pressing **Upload file** committed an entity titled
 * `placeholderTitleFor('File')` — "Untitled file" — with no bytes anywhere
 * behind it. Those entities list in the Files browser, offer a Download link,
 * and the download fails when it is followed.
 *
 * THE MECHANISM, CORRECTED AGAINST THE LIVE NODE (2026-08-28). The older note
 * here said `files.download` "joins onto `public.files` and finds no row",
 * which sent the next reader looking for file entities with no detail row —
 * there are none, and the query answers zero. `entities.create` for this kind
 * dispatches to the `create_file_entity` RPC, which DOES insert a `files` row:
 * `size_bytes 0`, a null checksum, and a `storage_path` under the space that
 * no blob is ever written to. The row is real; the bytes are not. The probe
 * that finds them is `size_bytes = 0 or checksum_sha256 is null`, and the live
 * download answers `not_found: no readable file`. ELEVEN exist across this
 * node's three spaces — four in the main one — not the three recorded before.
 *
 * An entity whose whole substance is its bytes cannot be created before the
 * bytes exist, so this control has no placeholder step: the picker opens, the
 * upload runs, and the entity appears only when the node has actually stored
 * something. If a file is picked and the upload fails, NOTHING is created —
 * which is the correct outcome and the opposite of what shipped.
 *
 * THE FLOW ITSELF IS NO LONGER HERE. It moved to `files/create.ts` when the
 * ROOT HEADERS turned out to need the same action without a button around it
 * (Tarkesh bug 01a04730): they draw their own ＋ and take an `onCreate`
 * callback, so they can be handed a function and not a component.
 */
import { useState } from 'react';
import type { CommandResult, EntityId, SpaceId } from '@tm8/contract';
import type { Seam } from '../data/seam';
import { runFileUploadCreate } from '../files/create';

export interface FileUploadCreateControlProps {
  label: string;
  spaceId: SpaceId;
  /**
   * REQUIRED, because `files` is required on `Seam` and all three call sites
   * pass it. An optional prop here bought a disabled "this node does not serve
   * uploads" branch that no wiring could ever reach — an unreachable honest
   * state is not honesty, it is dead code that reads as coverage.
   */
  files: Seam['files'];
  onCreated?: (id: EntityId, result: CommandResult) => void;
  onNotice?: (text: string) => void;
}

export function FileUploadCreateControl({
  label,
  spaceId,
  files,
  onCreated,
  onNotice,
}: FileUploadCreateControlProps) {
  const [busy, setBusy] = useState(0);

  /* The flow itself lives in the file lane (`files/create.ts`), because the
     LIST ROOT HEADER needs the same action without this button around it —
     that header owns its own ＋ and takes an `onCreate` callback, so a
     component cannot be handed to it. What is left here is the button: a
     label, a busy count, and a click. */
  const start = (): void => {
    void runFileUploadCreate({
      files,
      spaceId,
      ...(onCreated ? { onCreated } : {}),
      ...(onNotice ? { onNotice } : {}),
      onPending: (delta) => setBusy((n) => n + delta),
    });
  };

  return (
    <button
      type="button"
      className="tm8-btn"
      data-testid="file-create-upload"
      onClick={start}
      aria-busy={busy > 0}
    >
      {busy > 0 ? `Uploading ${busy}…` : label}
    </button>
  );
}
