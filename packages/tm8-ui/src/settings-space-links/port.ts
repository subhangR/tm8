/**
 * THE SPACE-LINKS PORT — Settings → Space links (W6). The same rule as
 * `settings-credentials/space-port.ts`: the section takes this narrow surface
 * and never imports a seam, so a fixture and a real node are indistinguishable
 * to it.
 *
 * EVERY WRITE BEHIND THIS IS HUMAN-ONLY, at the facade and again in SQL (251):
 * an agent is refused `forbidden` / `space_links_human_only`. The section
 * renders any refusal as a refusal, never swallowed.
 *
 * Nothing here takes or returns a secret: a link's stored session never leaves
 * the server; the viewer sees only their own row's metadata (`mine`).
 */
import type { EntityId, SpaceId, SpaceLinkInboundAuditEntry, SpaceLinkInboundView, SpaceLinkView } from '@tm8/contract';
import type { Seam } from '../data/seam';

/** A space the viewer could link to: one of their other memberships. */
export interface SpaceLinkCandidate {
  id: string;
  name: string;
}

export interface SpaceLinksPort {
  list(): Promise<SpaceLinkView[]>;
  /** The viewer's other spaces, for the add picker. Never includes this one. */
  candidates(): Promise<SpaceLinkCandidate[]>;
  add(targetSpaceId: string): Promise<SpaceLinkView>;
  login(linkId: string): Promise<SpaceLinkView>;
  relogin(linkId: string): Promise<SpaceLinkView>;
  logout(linkId: string): Promise<SpaceLinkView>;
  remove(linkId: string): Promise<SpaceLinkView>;
  setSpawn(linkId: string, allowSpawn: boolean, spawnBudget?: number): Promise<SpaceLinkView>;
  /**
   * 278 (D2): the links INTO this space, for its admins. A non-admin is
   * refused `forbidden` by the server and the section draws nothing for it.
   * Absent (an older port), the section draws no inbound block.
   */
  inbound?: SpaceLinksInboundPort;
}

export interface SpaceLinksInboundPort {
  list(): Promise<SpaceLinkInboundView[]>;
  audit(linkId: string): Promise<SpaceLinkInboundAuditEntry[]>;
  revoke(linkId: string): Promise<SpaceLinkInboundView>;
  restore(linkId: string): Promise<SpaceLinkInboundView>;
}

export function spaceLinksPortFromSeam(
  seam: Pick<Seam, 'spaceLinks' | 'spaces'>,
  spaceId: SpaceId,
): SpaceLinksPort {
  return {
    list: () => seam.spaceLinks.list(spaceId),
    candidates: async () =>
      (await seam.spaces()).filter((s) => s.id !== spaceId).map((s) => ({ id: s.id, name: s.name })),
    add: (targetSpaceId) => seam.spaceLinks.add(spaceId, targetSpaceId),
    login: (linkId) => seam.spaceLinks.login(linkId as EntityId),
    relogin: (linkId) => seam.spaceLinks.relogin(linkId as EntityId),
    logout: (linkId) => seam.spaceLinks.logout(linkId as EntityId),
    remove: (linkId) => seam.spaceLinks.remove(linkId as EntityId),
    setSpawn: (linkId, allowSpawn, spawnBudget) => seam.spaceLinks.setSpawn(linkId as EntityId, allowSpawn, spawnBudget),
    inbound: {
      list: () => seam.spaceLinks.inbound.list(spaceId),
      audit: (linkId) => seam.spaceLinks.inbound.audit(spaceId, linkId as EntityId),
      revoke: (linkId) => seam.spaceLinks.inbound.revoke(spaceId, linkId as EntityId),
      restore: (linkId) => seam.spaceLinks.inbound.restore(spaceId, linkId as EntityId),
    },
  };
}
