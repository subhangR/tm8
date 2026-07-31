import type { ChannelTagTarget } from './model';
import './tags.css';

export function TagSuggestion({ target, focused }: {
  target: ChannelTagTarget;
  focused: boolean;
}) {
  return (
    <span className="cv2-tag-option" data-focused={focused || undefined}>
      <span className="cv2-tag-option__glyph" aria-hidden>
        {target.group === 'Team members' ? '@' : '›_'}
      </span>
      <span className="cv2-tag-option__copy">
        <span className="cv2-tag-option__name">{target.display}</span>
        <span className="cv2-tag-option__meta">{target.meta}</span>
      </span>
      <span className="cv2-tag-option__group">{target.group}</span>
    </span>
  );
}
