import type { EntityDetail } from '@tm8/contract';
import { DisabledAction, NOT_WIRED_REASON } from '../panels/honesty/DisabledWithReason';
import { docBodyOf } from './commands';
import { canPrint } from './printDoc';

/**
 * `Download PDF` — the reader bar's second control, built to the same law as
 * its neighbour `EditEntryControl`: it is NEVER HIDDEN, and every way it cannot
 * run says which way that is. A viewer who cannot get a PDF is owed the reason,
 * not a missing button.
 *
 * THREE WAYS IT CANNOT RUN, and they are genuinely different facts:
 *   · the document is empty   — there is nothing to put in a PDF. `ReaderBody`
 *                               draws its designed empty in this same case, so
 *                               a live button here would offer to export the
 *                               sentence "This document has no content yet."
 *   · the browser cannot print — no `window.print`. A capability, not a
 *                               permission, and stated as one.
 *   · no handler wired         — the surface mounted without one. Passing
 *                               NOTHING is how a host says it cannot do this;
 *                               `no-op-handler-ban.test.ts` is the package law
 *                               that keeps `() => undefined` out of that seam.
 *
 * NOT A PERMISSION GATE. Reading a document and exporting what you have already
 * been shown are the same authority, so there is deliberately no `canEdit` or
 * `deletedAt` check here — a deleted doc you can still open is a deleted doc you
 * can still take a copy of. That divergence from `EditEntryControl` is the
 * point, not an oversight.
 */
export function DownloadDocControl({
  detail,
  onDownload,
  label = 'Download PDF',
}: {
  detail: EntityDetail;
  /** Absent ⇒ disabled-with-reason. Never a live control that does nothing. */
  onDownload?: () => void;
  label?: string;
}) {
  const reason =
    docBodyOf(detail).trim() === ''
      ? {
          cause: 'This document has no content yet',
          remedy: 'add some text before downloading a PDF',
        }
      : !canPrint()
        ? {
            cause: 'This browser cannot print',
            remedy: 'open the document in a browser that can, and save it as a PDF there',
          }
        : onDownload === undefined
          ? NOT_WIRED_REASON
          : null;

  if (reason) {
    return (
      <DisabledAction reason={reason} label={label}>
        {label}
      </DisabledAction>
    );
  }

  return (
    <button
      type="button"
      className="de-btn de-btn--quiet"
      data-testid="doc-download-pdf"
      onClick={onDownload}
    >
      {label}
    </button>
  );
}
