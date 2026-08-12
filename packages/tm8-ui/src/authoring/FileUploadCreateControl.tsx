/**
 * THE `file` KIND'S CREATE DOOR — an upload, because that is what the button
 * has always said.
 *
 * The `file` kind declared `palette: { createLabel: 'Upload file' }` and no
 * `createForm`, so `EntityCreateControl` fell through to the generic IMMEDIATE
 * flow: pressing **Upload file** committed an entity titled
 * `placeholderTitleFor('File')` — "Untitled file" — with no bytes anywhere
 * behind it. Those entities list in the Files browser, offer a Download link,
 * and 404 when it is followed, because `files.download` joins onto
 * `public.files` and finds no row. Three of them exist in the production
 * space, each one a press of this button.
 *
 * An entity whose whole substance is its bytes cannot be created before the
 * bytes exist, so this control has no placeholder step: the picker opens, the
 * upload runs, and the entity appears only when the node has actually stored
 * something. If a file is picked and the upload fails, NOTHING is created —
 * which is the correct outcome and the opposite of what shipped.
 */
import { useState } from 'react';
import type { CommandResult, EntityId, SpaceId } from '@tm8/contract';
import type { Seam } from '../data/seam';
import { pickFiles } from '../files/pick';
import { createFileUploadTask, safeUploadReason } from '../files/upload';

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

  const start = async (): Promise<void> => {
    const picked = await pickFiles({ multiple: true });
    if (picked.length === 0) return;
    setBusy((n) => n + picked.length);
    for (const file of picked) {
      const task = createFileUploadTask({ files, file, spaceId });
      void task.result
        .then((uploaded) => {
          // The entity id comes from the COMPLETED upload, so a caller that
          // navigates to it is navigating to something with bytes.
          onCreated?.(uploaded.fileEntityId, { patches: [] });
        })
        .catch((error: unknown) => {
          onNotice?.(`${file.name}: ${safeUploadReason(error)}`);
        })
        .finally(() => setBusy((n) => n - 1));
    }
  };

  return (
    <button
      type="button"
      className="tm8-btn"
      data-testid="file-create-upload"
      onClick={() => void start()}
      aria-busy={busy > 0}
    >
      {busy > 0 ? `Uploading ${busy}…` : label}
    </button>
  );
}
