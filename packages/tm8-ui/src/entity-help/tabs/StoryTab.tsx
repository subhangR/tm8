/**
 * STORY — what the entity is, why it exists, how it lives and ends.
 *
 * Opening passage, then the beats as a cascade, then the lifecycle as a
 * filmstrip: sprocketed frames in a row, one per stage, numbered like a reel.
 * The filmstrip is the tab's one piece of cinema chrome; everything else is
 * type on paper, because the story is the content and the frame must not
 * compete with it.
 */
import type { HelpPage } from '../resolve';
import { Reveal, Stagger } from '../motion/Reveal';

export function StoryTab({ page }: { page: HelpPage }) {
  const { story } = page;
  return (
    <div className="eh-story" data-testid="entity-help-story">
      <Reveal className="eh-prose eh-story__opening" delay={80}>
        {story.opening}
      </Reveal>

      <Stagger className="eh-beats" step={110} start={220} itemClassName="eh-beat">
        {story.beats.map((beat) => (
          <section key={beat.title} aria-label={beat.title}>
            {beat.eyebrow ? <span className="eh-eyebrow">{beat.eyebrow}</span> : null}
            <h3 className="eh-beat__title">{beat.title}</h3>
            <div className="eh-prose">{beat.body}</div>
          </section>
        ))}
      </Stagger>

      {story.lifecycle && story.lifecycle.length > 0 ? (
        <Reveal as="section" className="eh-film" delay={220 + story.beats.length * 110 + 120} data-testid="lifecycle-filmstrip">
          <span className="eh-eyebrow">Lifecycle</span>
          <ol className="eh-film__strip" aria-label={`${page.label} lifecycle`}>
            {story.lifecycle.map((stage, index) => (
              <li key={stage.name} className="eh-film__frame" style={{ ['--eh-delay' as string]: `${index * 90}ms` }}>
                <span className="eh-film__number" aria-hidden>
                  {String(index + 1).padStart(2, '0')}
                </span>
                <span className="eh-film__name">{stage.name}</span>
                <span className="eh-film__note">{stage.note}</span>
              </li>
            ))}
          </ol>
        </Reveal>
      ) : null}
    </div>
  );
}
