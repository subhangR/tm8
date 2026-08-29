/**
 * "＋ ATTACH A FILE" — the picker half of an upload, as one control.
 *
 * WHY IT LIVES IN `files/` AND NOT BESIDE THE HOOK. `useRichInput` owns the
 * upload MACHINE and takes files from three entry points (paste, drop, the
 * host's picker); the picker itself is markup — a hidden `<input type="file">`
 * and a button that clicks it — and every surface that adopted the hook was
 * about to write that markup again. It cannot live in `rich-input/` or in
 * `panels/`: both lanes' §15.2 guards read the string `'file'` as the entity
 * KIND, and only `files/` carves `type="file"` as the HTML attribute it is.
 * So the control is here, in the lane that already owns the word.
 *
 * NO DISABLED STATE, DELIBERATELY. A host with no uploader draws its OWN
 * `DisabledIconControl` with the reason that is true for it — "this panel was
 * mounted without an attachment port" is not the same sentence as "this
 * document refuses edits", and a generic refusal baked in here would flatten
 * both into one that explains neither.
 */
import { useRef, type ReactNode } from 'react';

export function ChooseFilesControl({
  label,
  title,
  className,
  inputClassName,
  children,
  onChoose,
}: {
  /** The accessible name of the button — the glyph is decorative. */
  label: string;
  title?: string;
  className?: string;
  inputClassName?: string;
  /** Visible content. Default: the ＋ every attach control in the app uses. */
  children?: ReactNode;
  onChoose: (files: FileList) => void;
}) {
  const input = useRef<HTMLInputElement | null>(null);
  return (
    <>
      <button
        type="button"
        className={className}
        aria-label={label}
        title={title}
        onClick={() => input.current?.click()}
      >
        {children ?? <span aria-hidden>＋</span>}
      </button>
      <input
        ref={input}
        type="file"
        multiple
        className={inputClassName}
        aria-label={`${label} — choose files`}
        onChange={(event) => {
          if (event.target.files) onChoose(event.target.files);
          // Same file twice in a row must fire change twice.
          event.target.value = '';
        }}
      />
    </>
  );
}
