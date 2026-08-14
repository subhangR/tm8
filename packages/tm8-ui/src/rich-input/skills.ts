/**
 * THE `/` TRIGGER'S SUBJECT — skills, loaded and referenced.
 *
 * THIS IS THE ONE FILE IN THE LANE THAT NAMES A KIND, and the lane guard says
 * so by name. The primitive (`useRichInput`, `triggers.ts`) knows no kinds —
 * that is its whole design, the same law `InlineTitleEditor` states for
 * titles. But the skill trigger IS about one kind: it queries skills and
 * writes skill references, and there is no structural discriminator to reach
 * for — the registry's skill row is field-for-field identical to the spell
 * row (same blocks, same `equipped` tint), so a "structural" lookup would be
 * a kind literal wearing a costume. Named plainly instead, in one file, with
 * the guard watching that it stays the only one.
 *
 * R1 GOVERNS THE SEMANTICS: a committed `/` REFERENCES a skill; it does not
 * invoke it. The reference is a markdown link in the body —
 *
 *     [/skill-name](tm8://skill/<entityId>)
 *
 * — because the body is the ONE channel that reaches an agent verbatim on
 * both delivery paths (the PTY envelope and chat-home's prompt both carry
 * body and routing facts only; `mentionIds`/`attachmentIds` are never
 * rendered into agent context). Message bodies are already markdown
 * end-to-end and `kit/Markdown` already resolves `tm8://` link targets, so
 * the same convention as `tm8://file/<id>` applies: the label is what the
 * human reads, the id is what survives a rename, and the agent resolves the
 * URI through its own tm8 tools if it chooses to activate anything.
 */
import type { CollectionQuery, CollectionResult, SpaceId } from '@tm8/contract';
import type { TriggerOption } from './triggers';

export interface SkillTriggerOption extends TriggerOption {
  id: string;
  /** The skill's name — what `/query` prefix-matches against. */
  display: string;
  /** `state.description`, when the projection carries one. */
  meta?: string;
}

interface SkillReadPort {
  query(input: CollectionQuery): Promise<CollectionResult>;
}

/**
 * Every skill in the space, alphabetical. Deliberately NOT filtered to
 * equipped: R1 references, it does not dispatch, and referencing a skill the
 * reading agent has not equipped is exactly the case the reference exists
 * for — the agent can read it and decide.
 */
export async function loadSkillTriggerOptions({
  port,
  spaceId,
}: {
  port: SkillReadPort;
  spaceId: SpaceId;
}): Promise<SkillTriggerOption[]> {
  const result = await port.query({
    spaceId,
    kinds: ['skill'],
    sort: 'activityAt_desc',
    limit: 100,
  });
  return result.page.items
    .map<SkillTriggerOption>((entity) => {
      const description = entity.state.kind === 'skill' ? entity.state.description : undefined;
      return {
        id: entity.id,
        display: entity.title,
        ...(description ? { meta: description } : {}),
      };
    })
    .sort((a, b) => a.display.localeCompare(b.display));
}

/**
 * `]` closes a markdown label early — backslash-escaping is CommonMark's own
 * answer. Same rule as the doc editor's file references.
 */
function escapeLabel(name: string): string {
  return name.replace(/([[\]\\])/g, '\\$1');
}

/** The committed text for a selected skill, trailing separator included. */
export function skillReference(name: string, skillId: string): string {
  const label = escapeLabel(name.trim() === '' ? 'skill' : name.trim());
  return `[/${label}](tm8://skill/${encodeURIComponent(skillId)}) `;
}
