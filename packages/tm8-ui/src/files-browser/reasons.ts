/**
 * THE GAP LEDGER FOR THE FILES SCREEN — every act this screen draws and this
 * build cannot perform, in one file, countable in one read.
 *
 * Precedent: `src/files/reasons.ts`, whose header records WHY the shape
 * exists: five dead verbs turned out to be a CLASS and nobody could see that
 * while the refusals were spread across five components.
 *
 * The distinction each entry preserves, because the remedies differ:
 *   SEAM GAP   — the capability exists server-side; the UI seam does not carry
 *                the verb. Remedy: a seam amendment.
 *   CAPABILITY — nothing anywhere performs it. Remedy: build it, server first.
 *
 * MEASURED 2026-08-09 against `src/data/seam.ts` on 541951a: the seam carries
 * `projectFiles` (list/read/attach) and carries NO `spaceFolders` group of any
 * kind. Every Space-folder refusal below is therefore the same single gap
 * stated at the place the user meets it, which is the point of the file.
 */
import type { UnavailableReason } from '../panels';

function reason(cause: string, remedy: string): UnavailableReason {
  return { cause, remedy };
}

/**
 * SEAM GAP. Space folders are a whole root KIND, so their absence is not a
 * missing button — it is half the screen. Said once, plainly, where the second
 * root group would be.
 */
export const SPACE_FOLDERS_UNAVAILABLE = reason(
  'This build cannot read Space folders',
  'the seam carries no spaceFolders group yet, so uploaded folders cannot be listed, browsed or read. Linked projects below are unaffected.',
);

export const FOLDER_UPLOAD_UNAVAILABLE = reason(
  'Uploading a folder is not connected in this build',
  'the archive is built in the page, but seam.spaceFolders.upload is the only thing entitled to send it and the seam does not carry it yet.',
);

/**
 * NOT a gap — a CONSEQUENCE, and the difference matters. Nothing is ever
 * written into a live project directory, because that would change the disk the
 * agents are working on. Uploading makes a SNAPSHOT instead, which is offered
 * rather than hidden behind this refusal.
 */
export const UPLOAD_INTO_PROJECT_REFUSED = reason(
  'Folders upload into a Space folder, not into a project',
  'a linked project is the live directory on the node; writing into it would change what the agents are working on. An upload here creates a Space-owned snapshot instead.',
);

/**
 * A Space folder is Space-OWNED (FILES-DESIGN R3: scope is space-only, no
 * workspace-level library), so with no Space in context there is nothing that
 * could own the result. A host state, not a missing capability.
 */
export const UPLOAD_NEEDS_SPACE = reason(
  'There is no Space to own an uploaded folder',
  'a Space folder belongs to a Space (R3: no workspace-level library), and this view has no Space selected.',
);

/**
 * A file whose bytes were never read has none to save. This is the honest
 * consequence of the read having been REFUSED, not a wiring gap, and it says
 * so — otherwise a user retries the download expecting a different answer.
 */
export const DOWNLOAD_WITHOUT_BYTES = reason(
  'There are no bytes to save',
  'the node did not return this file’s content, so the page holds nothing to write. The refusal above says why.',
);

/**
 * Asserted non-empty and fully formed by the suite, which also sweeps the
 * screen for a control that promises an act without one of these attached.
 */
export const ALL_FILES_BROWSER_REASONS: readonly UnavailableReason[] = [
  SPACE_FOLDERS_UNAVAILABLE,
  FOLDER_UPLOAD_UNAVAILABLE,
  UPLOAD_INTO_PROJECT_REFUSED,
  UPLOAD_NEEDS_SPACE,
  DOWNLOAD_WITHOUT_BYTES,
];
