import type { EntitySummary, SkillPreviewResult } from '@tm8/contract';
export interface SkillAuthoringInput { provider: string; level: string; root: string; name: string; description: string; body: string }
export interface SkillPort {
  roots(spaceId: string): Promise<{ projects: Array<{ id: string; workingDir: string }>; homes: string[] }>;
  list(spaceId: string, kind: 'skill' | 'team_member'): Promise<EntitySummary[]>;
  equip(id: string, teamMemberId: string, equipped: boolean): Promise<unknown>;
  create(spaceId: string, input: SkillAuthoringInput): Promise<unknown>;
  edit(id: string, input: { expectedVersion: number; contentHash?: string; name: string; description: string; body: string }): Promise<unknown>;
  preview(spaceId: string, input: { teamMemberId: string; projectId?: string; agentTool?: string }): Promise<SkillPreviewResult>;
}
