/**
 * RE-HOMED — `fileReference` and `spliceInto` live in
 * `rich-input/caretInsert.ts` now, because R4 made caret placement one of the
 * shared input primitive's two placements and the doc editor stopped being
 * the only surface that splices an upload into a draft. This shim keeps the
 * doc lane's import surface intact; the functions themselves moved verbatim,
 * original comments included.
 */
export { fileReference, spliceInto } from '../rich-input/caretInsert';
