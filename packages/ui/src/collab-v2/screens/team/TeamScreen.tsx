/**
 * Team screen (L5) — the humans of a space, each with the org-tree of agents
 * they own.
 *
 * Composition only: humans and agents arrive as two `kinds`-filtered
 * collection reads, every person renders as the Z2 `EntityCard` (role, score,
 * tasks done, model, live work — all registry-owned), live status comes from
 * `LiveBadges`, spawning opens the command palette in that member's context,
 * and a click promotes the profile to the Entity Z4 route.
 */
import { useMemo } from 'react';
import type { ShellViewProps } from '../../shell';
import { MemberCard } from './MemberCard';
import { groupByOwner, orgRows, tally } from './model';
import { useAgents, useMembers, useRosterNonce } from './useTeam';

export function TeamScreen({ facade, spaceId, onNavigate }: ShellViewProps) {
  const nonce = useRosterNonce(facade, spaceId);
  const members = useMembers(facade, spaceId, nonce);
  const agents = useAgents(facade, spaceId, nonce);

  const memberItems = useMemo(() => members.value?.page.items ?? [], [members.value]);
  const agentItems = useMemo(() => agents.value?.page.items ?? [], [agents.value]);
  const byOwner = useMemo(() => groupByOwner(agentItems), [agentItems]);
  const counts = useMemo(() => tally(memberItems, agentItems), [memberItems, agentItems]);

  const loading = members.loading || agents.loading;
  const error = members.error ?? agents.error;
  const openProfile = (id: string): void => onNavigate('entity', id);

  return (
    <div className="cv2-team" data-testid="team-screen">
      <header className="cv2-team__head">
        <span className="cv2-team__glyph" aria-hidden="true">👥</span>
        <span className="t-title">Team</span>
        <span className="t-secondary">
          {counts.humans} human{counts.humans === 1 ? '' : 's'} · {counts.agents} agent
          {counts.agents === 1 ? '' : 's'} · {counts.working} working
        </span>
      </header>

      {error && <div className="cv2-board__banner" role="alert">{error.message}</div>}
      {loading && memberItems.length === 0 && (
        <div className="cv2-collection__loading" role="status">loading…</div>
      )}

      <div className="cv2-team__grid">
        {memberItems.map((member) => (
          <MemberCard
            key={member.id}
            member={member}
            rows={orgRows(byOwner.get(member.id) ?? [])}
            facade={facade}
            onOpenProfile={openProfile}
          />
        ))}
      </div>

      {!loading && memberItems.length === 0 && !error && (
        <div className="cv2-collection__empty" role="status">
          <div className="cv2-collection__emptyglyph" aria-hidden="true">◇</div>
          <p>Nobody here yet — invite people from space settings.</p>
        </div>
      )}
    </div>
  );
}
