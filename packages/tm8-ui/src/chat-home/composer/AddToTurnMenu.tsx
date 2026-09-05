/**
 * ＋ — "ADD TO THIS TURN": what the turn can DRAW ON.
 *
 * The admission test for a row here: does it change what the turn can draw
 * on? Attachments are content in; skills are behaviour packs; MCPs are tool
 * servers. Anything that changes how the turn BEHAVES is a setting and lives
 * in the row or the rail, not here.
 *
 * Two temporalities, split by a rule: the top section is ONE-SHOT and makes
 * pills; the bottom is STICKY and shows as checked. Active state never lives
 * only inside the closed menu — the host draws enabled skills as pills beside
 * the ＋ and this trigger carries their count.
 *
 * WHAT IS HONESTLY ABSENT: this node exposes no MCP catalog to the chat
 * surface and the chat wire carries no `mentionIds`, so "Reference entity"
 * and "Browse MCPs" render disabled WITH the reason rather than as live rows
 * that swallow the press.
 */
import type { ChangeEvent } from 'react';
import type { TriggerOption } from '../../rich-input';
import { ComposerPopover } from './ComposerPopover';

export interface AddToTurnMenuProps {
  /** Present ⇒ the file rows are live. */
  onChooseFiles?: (files: FileList) => void;
  skillOptions?: readonly TriggerOption[];
  enabledSkills: readonly string[];
  onToggleSkill: (id: string) => void;
  /** Opens the typed `/` picker, for a roster too long to check one by one. */
  onBrowseSkills?: () => void;
  disabled?: boolean;
  testId?: string;
}

export function AddToTurnMenu({
  onChooseFiles,
  skillOptions,
  enabledSkills,
  onToggleSkill,
  onBrowseSkills,
  disabled = false,
  testId = 'tch-add',
}: AddToTurnMenuProps) {
  const filesReason = 'uploading isn’t wired on this surface — this chat was mounted without an attachment port';
  const pick = (accept: string | undefined, close: () => void) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.multiple = true;
    if (accept) input.accept = accept;
    input.onchange = (event) => {
      const files = (event.target as HTMLInputElement).files;
      if (files && files.length) onChooseFiles?.(files);
      close();
    };
    input.click();
  };
  return (
    <ComposerPopover
      label="Add to this turn"
      testId={testId}
      badge={enabledSkills.length}
      disabled={disabled}
      title="add to this turn — files, images, skills"
      menuWidth={272}
      menuHeight={360}
      className="tch-attach"
      trigger={<span className="tch-pop__plus" aria-hidden>+</span>}
    >
      {(close) => (
        <div className="tch-addmenu">
          <p className="tch-addmenu__head">Add to this turn</p>
          <button
            type="button"
            className="tch-addmenu__row"
            data-testid={`${testId}-file`}
            aria-label="Attach a file"
            aria-disabled={onChooseFiles ? undefined : true}
            title={onChooseFiles ? undefined : filesReason}
            onClick={() => { if (onChooseFiles) pick(undefined, close); }}
          >
            Attach file…
            {onChooseFiles ? null : <span className="tch-addmenu__why">{filesReason}</span>}
          </button>
          <button
            type="button"
            className="tch-addmenu__row"
            data-testid={`${testId}-image`}
            aria-disabled={onChooseFiles ? undefined : true}
            title={onChooseFiles ? undefined : filesReason}
            onClick={() => { if (onChooseFiles) pick('image/*', close); }}
          >
            Image…
          </button>
          <button
            type="button"
            className="tch-addmenu__row"
            data-testid={`${testId}-entity`}
            aria-disabled
            title="the chat wire carries no entity mentions yet — paste an id or a link into the message instead"
          >
            Reference entity… <span className="tch-addmenu__why">not on this node</span>
          </button>
          <p className="tch-addmenu__head tch-addmenu__head--sticky">Enabled for this turn</p>
          {skillOptions && skillOptions.length ? (
            <div className="tch-addmenu__skills" role="group" aria-label="Skills">
              {skillOptions.slice(0, 8).map((skill) => {
                const on = enabledSkills.includes(skill.id);
                return (
                  <label key={skill.id} className="tch-addmenu__skill" data-on={on || undefined}>
                    <input
                      type="checkbox"
                      data-testid={`${testId}-skill-${skill.id}`}
                      checked={on}
                      onChange={(_event: ChangeEvent<HTMLInputElement>) => onToggleSkill(skill.id)}
                    />
                    <span className="tch-addmenu__skillname">{skill.display}</span>
                    <span className="tch-addmenu__kind">skill</span>
                  </label>
                );
              })}
              {skillOptions.length > 8 || onBrowseSkills ? (
                <button
                  type="button"
                  className="tch-addmenu__row" data-more
                  data-testid={`${testId}-browse`}
                  onClick={() => { close(); onBrowseSkills?.(); }}
                  aria-disabled={onBrowseSkills ? undefined : true}
                >
                  + Browse all {skillOptions.length} skills…
                </button>
              ) : null}
            </div>
          ) : (
            <p className="tch-pickmenu__note">No skills are published in this space.</p>
          )}
          <p className="tch-addmenu__foot" role="note">
            MCP servers: this node exposes no MCP catalog to chat yet.
          </p>
        </div>
      )}
    </ComposerPopover>
  );
}
