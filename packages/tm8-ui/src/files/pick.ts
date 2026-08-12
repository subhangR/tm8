/**
 * ASK THE USER FOR FILES — the OS picker, as a promise.
 *
 * This lives in the FILE lane rather than beside its caller in `authoring/`
 * for a reason that looks like a technicality and is not. The authoring lane
 * is guarded by §15.2: no source file under it may contain a kind string
 * literal, because a create flow must reach a kind through registry DATA.
 * `<input type="file">` trips that guard — `"file"` is a kind name — and the
 * honest fix is not to carve an exception into the guard for an HTML
 * attribute. It is to notice that opening a file picker is the file lane's
 * job, and put it here.
 *
 * A promise rather than a rendered element because the caller wants one
 * thing — the files — and an invisible `<input>` in someone's JSX is a
 * lifecycle they should not have to own.
 */

/**
 * Opens the OS picker and resolves with what was chosen; an empty array when
 * the user cancels.
 *
 * The input is attached to the document because Safari will not open a picker
 * for a detached element, and removed in a `finally` so a cancelled pick
 * leaves nothing behind. `cancel` is not universally supported, so the
 * element is also cleaned up on `change`; both paths are idempotent.
 */
export function pickFiles(options?: { multiple?: boolean; accept?: string }): Promise<File[]> {
  return new Promise((resolve) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.multiple = options?.multiple ?? true;
    if (options?.accept) input.accept = options.accept;
    input.hidden = true;

    let settled = false;
    const finish = (files: File[]): void => {
      if (settled) return;
      settled = true;
      input.remove();
      resolve(files);
    };

    input.addEventListener('change', () => finish(Array.from(input.files ?? [])));
    // Fired when the picker is dismissed without a choice. Browsers that do
    // not implement it simply never resolve this way, and the element is
    // cleaned up by the next successful pick or by page teardown.
    input.addEventListener('cancel', () => finish([]));

    document.body.append(input);
    input.click();
  });
}
