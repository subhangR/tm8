import { JEV_UNAVAILABLE_COPY, type JevSuggestions } from './useJevSuggestions';
import { JevCostLine } from './JevCostLine';

/**
 * The run's footer line: the whole run's cost, the stale and unavailable
 * states, the note when Launch will NOT carry the ticks, and Reset to defaults.
 * Shared by both surfaces; renders nothing before the first press.
 */
export function JevRunBar({ jev, inline }: { jev: JevSuggestions; /** Inside the popup's strip: no rule, no run cost (the strip shows it). */ inline?: boolean }) {
  if (jev.state === 'idle') return null;
  return (
    <div className={inline ? 'jev-runbar jev-runbar--inline' : 'jev-runbar'} data-testid="jev-runbar" data-state={jev.state}>
      {jev.state === 'unavailable' ? (
        <span className="jev-runbar__note" role="status" data-testid="jev-unavailable">{JEV_UNAVAILABLE_COPY}</span>
      ) : null}
      {jev.state === 'stale' ? (
        <span className="jev-runbar__note" role="status" data-testid="jev-stale">
          Changed since Jev looked —{' '}
          <button type="button" className="jev-link" data-testid="jev-ask-again" onClick={(e) => { e.stopPropagation(); jev.ask(); }}>
            Ask again
          </button>
        </span>
      ) : null}
      {jev.launchNote ? (
        <span className="jev-runbar__note jev-runbar__note--warn" role="status" data-testid="jev-launch-note">{jev.launchNote}</span>
      ) : null}
      <span className="jev-runbar__spacer" />
      {jev.run && !inline ? <JevCostLine run={jev.run} /> : null}
      {jev.jevMode ? (
        <button type="button" className="jev-link" data-testid="jev-reset" onClick={(e) => { e.stopPropagation(); jev.reset(); }}>
          Reset to defaults
        </button>
      ) : null}
    </div>
  );
}
