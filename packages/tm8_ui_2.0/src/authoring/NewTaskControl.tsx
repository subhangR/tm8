import { DisabledAction } from '../panels/honesty/DisabledWithReason';
import { RefusalCard } from './RefusalCard';
import type { NewTaskHandle } from './useNewTask';

/**
 * THE CREATE AFFORDANCE.
 *
 * IT DELIBERATELY DOES NOT RESTYLE THE CHIP. D58 ruled the create chip INK
 * (`--pn-ink` fill / `--pn-paper` text, r7, 4px 10px, 12px 600, hover
 * `--pn-x-btn-ink-hover`) from the T0-1 oracle, and `.lp__new` in
 * `panels.css` already carries exactly that. The authoring canvas draws the
 * same chip in BRASS — an older, superseded pixel — and transcribing it here
 * would re-open a ruling on the strength of a canvas that lost it.
 *
 * So this component wears `lp__new` and adds ONLY the two states that chip has
 * never had: in-flight and refused. Nothing in `authoring.css` sets a colour,
 * a radius or a padding on `.lp__new`.
 *
 * THE PENDING STATE IS NOT DECORATION. The oracle's promise is "created for
 * real, instantly" — but the network is between the press and the row, and a
 * chip that looks identical during that window is a chip the user presses
 * again. `aria-busy` + the visible "creating…" word + the hook's phase guard
 * are three layers of the same statement, and only the first two are visible
 * to the person waiting.
 */
export function NewTaskControl({
  flow,
  label,
  className = 'lp__new',
}: {
  flow: NewTaskHandle;
  /** From the registry (`palette.createLabel`), never a literal here. */
  label: string;
  /** The host's own chip class. Defaults to the list panel's. */
  className?: string;
}) {
  if (flow.unavailable) {
    return (
      <DisabledAction reason={flow.unavailable} label={label}>
        {label}
      </DisabledAction>
    );
  }

  const creating = flow.state.phase === 'creating';

  return (
    <>
      <button
        type="button"
        className={creating ? `${className} au-create--pending` : className}
        aria-busy={creating}
        onClick={() => void flow.create()}
      >
        {label}
      </button>
      {creating ? (
        <span className="au-pending" data-testid="authoring-pending" role="status">
          creating…
        </span>
      ) : null}
      {flow.state.phase === 'refused' ? (
        <RefusalCard
          word={flow.state.failure.cause}
          detail={flow.state.failure.detail}
          aftermath={flow.state.failure.aftermath}
          note={flow.state.failure.retryable ? undefined : 'not retryable — the node said so'}
          moves={[
            ...(flow.state.failure.retryable
              ? [{ label: 'retry', onSelect: () => void flow.create() }]
              : []),
            { label: 'dismiss', onSelect: flow.dismiss },
          ]}
        />
      ) : null}
    </>
  );
}
