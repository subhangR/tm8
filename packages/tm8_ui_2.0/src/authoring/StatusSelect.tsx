import { useRef, useState } from 'react';
import type { WorkStatus } from '@tm8/contract';
import { Pill, type PillTone } from '../kit';
import { useDismissable } from '../panels/useDismissable';

/**
 * THE HEADER STATUS PILL, MADE EDITABLE.
 *
 * T0-4 draws it as `● working ▾` with `cursor:pointer` — a pill that is also a
 * picker. The caret is the whole affordance: without it the pill is
 * indistinguishable from the read-only pills every other kind wears, and the
 * user has no way to learn the status can be changed here.
 *
 * OPTIONS ARE DATA, and they are the CONTRACT'S OWN vocabulary. `value` and
 * `option.value` are typed `WorkStatus`, so an invented status is a type error
 * rather than a 400 discovered at runtime — and the caller derives the list
 * from the registry's `panel.statusPill` (labels + tones), which is where the
 * words and colours already live (D22: status words live in the registry, not
 * in a render path). Nothing here knows a kind.
 *
 * `editable=false` renders the ordinary Pill with no caret and no picker —
 * the same component, one fewer affordance, so a locked status cannot
 * accidentally look clickable.
 *
 * Dismissal goes through the SHARED `useDismissable` rather than a local
 * listener: D35's corollary was paid for by two popovers that trapped the
 * user, and re-solving it here would recreate exactly that.
 */
export interface StatusOption {
  value: WorkStatus;
  label: string;
  tone: PillTone;
}

export function StatusSelect({
  value,
  options,
  editable,
  onSelect,
}: {
  value: WorkStatus;
  options: readonly StatusOption[];
  editable: boolean;
  onSelect(next: WorkStatus): void;
}) {
  const [open, setOpen] = useState(false);
  const host = useRef<HTMLSpanElement | null>(null);
  useDismissable(open, host, () => setOpen(false));

  const current = options.find((o) => o.value === value);
  // An unlisted value is SHOWN, never swallowed: the record says what it says,
  // and hiding a status we have no word for would be the more confident lie.
  const label = current?.label ?? value.replace(/_/g, ' ');
  const tone = current?.tone ?? 'idle';

  if (!editable) {
    return (
      <span ref={host} data-testid="authoring-status">
        <Pill tone={tone} dot="solid">
          {label}
        </Pill>
      </span>
    );
  }

  return (
    <span className="au-status" ref={host}>
      <button
        type="button"
        className="au-status__trigger"
        data-testid="authoring-status"
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label={`Status: ${label}`}
        onClick={() => setOpen((v) => !v)}
      >
        <Pill tone={tone} dot="solid">
          {label}
        </Pill>
        <span className="au-status__caret" aria-hidden>
          ▾
        </span>
      </button>
      {open ? (
        <span className="au-status__menu" role="listbox" aria-label="Status">
          {options.map((option) => (
            <button
              key={option.value}
              type="button"
              role="option"
              aria-selected={option.value === value}
              className={
                option.value === value ? 'au-status__option au-status__option--on' : 'au-status__option'
              }
              onClick={() => {
                setOpen(false);
                if (option.value !== value) onSelect(option.value);
              }}
            >
              <Pill tone={option.tone} dot="solid">
                {option.label}
              </Pill>
            </button>
          ))}
        </span>
      ) : null}
    </span>
  );
}
