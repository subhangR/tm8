/**
 * THE ONE PICKER — a listbox over the textarea, driven entirely by the hook.
 *
 * A view for hosts that do not already own popover markup (the doc editor,
 * the entity Discussion composer, chat-home). `channel-screen/Composer` keeps
 * its own `chs-*` markup over the same hook state — the shared thing is the
 * BEHAVIOUR, and two stylesheets over one contract is the intended shape, not
 * a fork.
 *
 * The popover has no focusable parts: the textarea drives it, per the hook's
 * keyboard contract. Rows are buttons only so a mouse can commit them; hover
 * moves the highlight so the mouse and the arrow keys never disagree about
 * which row Enter would take.
 *
 * POSITIONING: `.ri-popover` pins itself above the nearest positioned
 * ancestor — the host wraps its textarea in a `position: relative` container
 * (`.ri-host` is provided for exactly this).
 */
import { useEffect, useRef } from 'react';
import type { ReactNode } from 'react';
import type { RichInputPopover } from './useRichInput';
import type { TriggerOption } from './triggers';

export function TriggerPopover({
  popover,
  label,
  renderOption,
  emptyText,
  testId,
}: {
  popover: RichInputPopover | null;
  /** Names the listbox for assistive tech, e.g. "Available skills". */
  label: string;
  /** Row content. Default: display, with `meta` in the trailing slot. */
  renderOption?: (option: TriggerOption) => ReactNode;
  emptyText?: string;
  testId?: string;
}) {
  const listbox = useRef<HTMLDivElement>(null);

  /**
   * Keep the highlighted row inside the scroll port. `scrollIntoView` is
   * optional-called because jsdom does not implement it — the guard keeps
   * the keyboard tests honest instead of stubbing the DOM.
   */
  useEffect(() => {
    if (!popover) return;
    const active = listbox.current?.querySelector('[data-active="true"]');
    (active as HTMLElement | null)?.scrollIntoView?.({ block: 'nearest' });
  }, [popover, popover?.activeIndex]);

  if (!popover) return null;

  return (
    <div className="ri-popover" data-testid={testId ?? 'ri-popover'}>
      {popover.query ? (
        <p className="ri-popover__query">{`Matching “${popover.query}”`}</p>
      ) : null}
      <div id={popover.listboxId} ref={listbox} role="listbox" aria-label={label}>
        {popover.options.map((option, index) => (
          <button
            key={option.id}
            id={popover.optionDomId(option)}
            type="button"
            role="option"
            data-active={index === popover.activeIndex}
            aria-selected={false}
            onMouseEnter={() => popover.setActive(index)}
            onClick={() => popover.select(option)}
          >
            {renderOption ? renderOption(option) : (
              <>
                <span className="ri-popover__name">{option.display}</span>
                {option.meta ? <span className="ri-popover__meta">{option.meta}</span> : null}
              </>
            )}
          </button>
        ))}
      </div>
      {popover.options.length ? null : (
        <p className="ri-popover__empty" role="status">
          {emptyText ?? `No matches for “${popover.sigil}${popover.query}”`}
        </p>
      )}
    </div>
  );
}
