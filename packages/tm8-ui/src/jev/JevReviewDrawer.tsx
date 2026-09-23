import { JevChecklist } from './JevChecklist';
import type { JevSuggestions } from './useJevSuggestions';

/**
 * The Run popup's Review drawer: the SAME `JevChecklist` LaunchSheet renders,
 * for both groups, so a tick means the same thing on both surfaces.
 */
export function JevReviewDrawer({ jev, onClose }: { jev: JevSuggestions; onClose(): void }) {
  return (
    <section className="jev-drawer" data-testid="jev-review-drawer" aria-label="Jev’s memories and skills">
      <div className="jev-drawer__head">
        <span className="jev-drawer__title">✦ Memories and skills for this session</span>
        {jev.jevMode ? (
          <button type="button" className="jev-link" data-testid="jev-drawer-reset" onClick={jev.reset}>
            Reset to defaults
          </button>
        ) : null}
        <button type="button" className="jev-link" data-testid="jev-review-close" onClick={onClose}>
          Close
        </button>
      </div>
      <div className="jev-drawer__section">
        <span className="jev-drawer__eyebrow">MEMORIES</span>
        <JevChecklist
          kind="memory"
          state={jev.groups.memories}
          ticked={jev.ticked.memory}
          refusal={jev.tickRefusal?.kind === 'memory' ? jev.tickRefusal : null}
          onToggle={(id) => jev.toggle('memory', id)}
          onRetry={jev.retry}
        />
      </div>
      <div className="jev-drawer__section">
        <span className="jev-drawer__eyebrow">SKILLS</span>
        <JevChecklist
          kind="skill"
          state={jev.groups.skills}
          ticked={jev.ticked.skill}
          refusal={jev.tickRefusal?.kind === 'skill' ? jev.tickRefusal : null}
          onToggle={(id) => jev.toggle('skill', id)}
          onRetry={jev.retry}
        />
      </div>
    </section>
  );
}
