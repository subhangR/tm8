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
 * ON THE PHONE IT IS THE ＋ SHEET (chat v2 mockup 01a14cba): the card holds
 * only the field and the foot, so everything that rides along with this
 * message — staged files, enabled skills, entity refs — is listed at the top of
 * the sheet as "Attached to this message · N" with a ✕ each, and ＋ carries N.
 * Under it, the Add grid; Skill / Team / Connectors open their list in place.
 *
 * WHAT IS HONESTLY ABSENT: this node exposes no MCP catalog to the chat
 * surface and the chat wire carries no `mentionIds`, so "Reference entity"
 * and "Browse MCPs" render disabled WITH the reason rather than as live rows
 * that swallow the press.
 */
import { useState, type ChangeEvent, type ReactNode } from 'react';
import type { TriggerOption } from '../../rich-input';
import { useMobileSurface } from '../../mobile';
import { ComposerIcon } from './ComposerIcons';
import { ComposerPopover } from './ComposerPopover';

/** One row of the phone sheet's "Attached to this message" list. */
export interface AttachedItem {
  key: string;
  /** A glyph for what it is (file, image, skill, entity) — decorative. */
  icon: string;
  name: string;
  /** "image · 412 KB", "skill", "uploading…", a failure's reason. */
  meta: string;
  /** Drawn in the alert colour: a failed upload. */
  failed?: boolean;
  removeLabel: string;
  onRemove: () => void;
  onRetry?: () => void;
}

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
  /** One more section, folded under `extraLabel` (the compact composer's Coordinator team). */
  extra?: ReactNode;
  extraLabel?: string;
  /** Present ⇒ the connectors picker (or its load failure) in place of the no-catalog note. */
  connectors?: ReactNode;
  /**
   * Phone only: everything riding with this message. The card draws none of
   * it there, so this list is where it is seen and removed, and its length is
   * the badge on ＋. Ignored off the phone, where the host draws its chips.
   */
  attached?: readonly AttachedItem[];
}

type SheetView = 'add' | 'skills' | 'team' | 'connectors';

export function AddToTurnMenu({
  onChooseFiles,
  skillOptions,
  enabledSkills,
  onToggleSkill,
  onBrowseSkills,
  disabled = false,
  testId = 'tch-add',
  extra,
  extraLabel,
  connectors,
  attached = [],
}: AddToTurnMenuProps) {
  const { oneSurface: phone } = useMobileSurface();
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
      badge={phone ? attached.length : enabledSkills.length}
      disabled={disabled}
      title="add to this turn — files, images, skills"
      menuWidth={extra ? 380 : 272}
      menuHeight={extra ? 520 : 360}
      fitViewport
      className="tch-attach"
      trigger={<ComposerIcon name="plus" />}
    >
      {(close) => phone ? (
        <AddSheet
          testId={testId}
          attached={attached}
          onPhoto={onChooseFiles ? () => pick('image/*', close) : undefined}
          onFile={onChooseFiles ? () => pick(undefined, close) : undefined}
          filesReason={filesReason}
          skills={
            <SkillChecks
              testId={testId}
              skillOptions={skillOptions}
              enabledSkills={enabledSkills}
              onToggleSkill={onToggleSkill}
              onBrowseSkills={onBrowseSkills ? () => { close(); onBrowseSkills(); } : undefined}
            />
          }
          team={extra}
          teamLabel={extraLabel}
          connectors={connectors}
        />
      ) : (
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
          <SkillChecks
            testId={testId}
            skillOptions={skillOptions}
            enabledSkills={enabledSkills}
            onToggleSkill={onToggleSkill}
            onBrowseSkills={onBrowseSkills ? () => { close(); onBrowseSkills(); } : undefined}
          />
          {extra ? (
            <details className="tch-addmenu__extra" data-testid={`${testId}-extra`}>
              <summary className="tch-addmenu__head tch-addmenu__head--sticky">{extraLabel}</summary>
              {extra}
            </details>
          ) : null}
          {connectors ? (
            <div className="tch-addmenu__connectors" data-testid={`${testId}-connectors`}>{connectors}</div>
          ) : (
            <p className="tch-addmenu__foot" role="note">
              MCP servers: this node exposes no MCP catalog to chat yet.
            </p>
          )}
        </div>
      )}
    </ComposerPopover>
  );
}

/** The sticky skill checklist — the desktop menu's section and the phone sheet's Skill view. */
function SkillChecks({
  testId,
  skillOptions,
  enabledSkills,
  onToggleSkill,
  onBrowseSkills,
}: {
  testId: string;
  skillOptions: readonly TriggerOption[] | undefined;
  enabledSkills: readonly string[];
  onToggleSkill: (id: string) => void;
  onBrowseSkills: (() => void) | undefined;
}) {
  if (!skillOptions || !skillOptions.length) {
    return <p className="tch-pickmenu__note">No skills are published in this space.</p>;
  }
  return (
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
          onClick={() => onBrowseSkills?.()}
          aria-disabled={onBrowseSkills ? undefined : true}
        >
          + Browse all {skillOptions.length} skills…
        </button>
      ) : null}
    </div>
  );
}

/**
 * THE PHONE'S ＋ SHEET, as the mockup draws it: the attached list, then a
 * four-column Add grid of 72px tiles. Tiles that open a list (Skill, Team,
 * Connectors) swap the grid for that list with a ‹ back to it; the attached
 * list stays on top throughout so a toggle is seen landing there.
 */
function AddSheet({
  testId,
  attached,
  onPhoto,
  onFile,
  filesReason,
  skills,
  team,
  teamLabel,
  connectors,
}: {
  testId: string;
  attached: readonly AttachedItem[];
  onPhoto: (() => void) | undefined;
  onFile: (() => void) | undefined;
  filesReason: string;
  skills: ReactNode;
  team: ReactNode | undefined;
  teamLabel: string | undefined;
  connectors: ReactNode | undefined;
}) {
  /* Lives here, not in the menu, so it resets every time the sheet closes. */
  const [view, setView] = useState<SheetView>('add');
  const entityReason = 'the chat wire carries no entity mentions yet — paste an id or a link into the message instead';
  const tile = (key: string, icon: string, label: string, onClick: (() => void) | undefined, reason?: string) => (
    <button
      key={key}
      type="button"
      className="tch-addsheet__tile"
      data-testid={`${testId}-${key}`}
      aria-disabled={onClick ? undefined : true}
      title={onClick ? undefined : reason}
      onClick={() => onClick?.()}
    >
      <span className="tch-addsheet__icon" aria-hidden>{icon}</span>
      {label}
    </button>
  );
  const sub = (title: string, body: ReactNode) => (
    <div className="tch-addsheet__sub" data-testid={`${testId}-view-${view}`}>
      <button type="button" className="tch-addsheet__back" onClick={() => setView('add')}>
        <span aria-hidden>‹</span> {title}
      </button>
      {body}
    </div>
  );
  return (
    <div className="tch-addsheet" data-testid={`${testId}-body`}>
      {attached.length ? (
        <>
          <p className="tch-addsheet__label">Attached to this message · {attached.length}</p>
          <ul className="tch-addsheet__attached" aria-label="Attached to this message" aria-live="polite">
            {attached.map((item) => (
              <li key={item.key} className="tch-addsheet__item" data-failed={item.failed || undefined}>
                <span className="tch-addsheet__icon" aria-hidden>{item.icon}</span>
                <span className="tch-addsheet__text">
                  <b>{item.name}</b>
                  <i role={item.failed ? 'alert' : undefined}>{item.meta}</i>
                </span>
                {item.onRetry ? (
                  <button type="button" className="tch-addsheet__retry" onClick={item.onRetry} aria-label={`Try ${item.name} again`}>
                    retry
                  </button>
                ) : null}
                <button type="button" className="tch-addsheet__x" onClick={item.onRemove} aria-label={item.removeLabel}>
                  <span aria-hidden>✕</span>
                </button>
              </li>
            ))}
          </ul>
        </>
      ) : null}
      {view === 'skills' ? sub('Skills', skills)
        : view === 'team' && team ? sub(teamLabel ?? 'Team', team)
        : view === 'connectors' && connectors ? sub('Connectors', connectors)
        : (
          <>
            <p className="tch-addsheet__label">Add</p>
            <div className="tch-addsheet__grid">
              {tile('image', '📷', 'Photo', onPhoto, filesReason)}
              {tile('file', '📎', 'File', onFile, filesReason)}
              {tile('entity', '#', 'Entity', undefined, entityReason)}
              {tile('skills', '⚡', 'Skill', () => setView('skills'))}
              {team ? tile('team', '👥', 'Team', () => setView('team')) : null}
              {connectors ? tile('connectors', '🔌', 'Connectors', () => setView('connectors')) : null}
            </div>
          </>
        )}
    </div>
  );
}
