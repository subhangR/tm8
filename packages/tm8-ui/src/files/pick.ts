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
 * for a detached element.
 *
 * CANCELLATION IS THE HARD PART. `change` does not fire when a user dismisses
 * the dialog, and the `cancel` event is not universally supported. An earlier
 * version relied on `cancel` alone and claimed the element would otherwise be
 * "cleaned up by the next successful pick" — which was simply false: `finish`
 * closes over its OWN input, so every dismissed pick on a browser without
 * `cancel` left an `<input>` in the document forever and left this promise
 * pending, so the caller's `await` never returned.
 *
 * The fallback is the window regaining focus: the file dialog is modal, so
 * focus returning without a `change` having fired means the user dismissed it.
 * One frame of slack is allowed for `change`, which in some browsers lands
 * just after focus. Every path resolves exactly once and removes the element.
 */
export function pickFiles(options?: { multiple?: boolean; accept?: string }): Promise<File[]> {
  return new Promise((resolve) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.multiple = options?.multiple ?? true;
    if (options?.accept) input.accept = options.accept;
    input.hidden = true;

    let settled = false;
    let onFocus: () => void = () => undefined;
    const finish = (files: File[]): void => {
      if (settled) return;
      settled = true;
      window.removeEventListener('focus', onFocus);
      input.remove();
      resolve(files);
    };

    const finishEmpty = (): void => finish([]);

    input.addEventListener('change', () => finish(Array.from(input.files ?? [])));
    input.addEventListener('cancel', finishEmpty);
    // The universal fallback. Deferred a turn so a `change` that arrives just
    // after focus wins the race and reports the real selection.
    onFocus = (): void => {
      setTimeout(() => {
        if (!settled) finishEmpty();
      }, 0);
    };
    window.addEventListener('focus', onFocus, { once: true });

    document.body.append(input);
    input.click();
  });
}
