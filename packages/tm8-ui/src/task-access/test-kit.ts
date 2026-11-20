import { vi } from 'vitest';
import type { EdgeView, EntityDetail, EntityId, EntitySummary, Page, ProjectResource, SessionLaunchRecord, SpaceCredentialView } from '@tm8/contract';
import type { ConnectionOpts, Seam } from '../data/seam';
import { fixtureDetails, taskGuideLines, taskUuidTitle, sessionStale } from '../fixtures';

export const TASK = taskGuideLines.id;
export const NEXT_TASK = 'next-task' as EntityId;
export const RUN = sessionStale.id;
export const PROJECT = 'project-access';
export const CREDENTIAL = 'credential-used';
export const caps = { canEdit: true, canDelete: false, canAddChild: true, canLink: true,
  canPull: false, canReact: true, canGrantPoints: false, canComplete: true };
export const task = (id = TASK): EntityDetail => ({ ...fixtureDetails[taskUuidTitle.id]!, id, capabilities: { ...caps } });
export const session = (id = RUN): EntitySummary => ({ ...sessionStale, id, title: `Run ${id}` });
export const edge = (source: EntitySummary, target: EntitySummary): EdgeView => ({ id: `${source.id}-${target.id}`, source, target } as EdgeView);
export const projectPeer = { ...taskGuideLines, id: PROJECT as EntityId, title: 'App', kind: 'project', state: { kind: 'project', projectId: PROJECT } } as EntitySummary;
export const record = (over: Partial<SessionLaunchRecord> = {}): SessionLaunchRecord => ({
  sessionId: RUN, available: true, unavailableReason: null, recordedAt: '2026-11-21T01:00:00.000Z',
  manifest: { session: { workingDirectory: '/worktrees/run', workdirMode: 'worktree' },
    project: { id: PROJECT, name: 'Do not trust snapshot name' },
    launch: { accessMode: 'plan', accessModeSource: 'inherited', permissionMode: 'readOnly',
      credentialSources: { github: 'node' }, effectiveCredentialSources: { github: 'space' },
      spaceCredentialIds: { github: CREDENTIAL },
      commandNetwork: { mode: 'loopback-proxy', allowedHosts: ['127.0.0.1'], portScoped: false },
      secret: 'MANIFEST_SECRET' }, secret: 'MANIFEST_SECRET' },
  envVarNames: ['ENV_SECRET'], prompts: { system: 'PROMPT_SECRET', task: 'PROMPT_SECRET', unavailableReason: null },
  launchContext: null,
  connectorAccounts: { available: true, unavailableReason: null, hiddenCount: 1, entries: [{
    serverId: 'connector' as EntityId, serverName: 'Drive', credentialRequired: true,
    account: { id: 'connector-account', label: 'Work alice@example.com', accountLabel: 'alice@example.com',
      grantedScopes: ['drive.readonly'], usable: false, status: 'revoked', reason: 'credential_revoked' },
  }] }, ...over,
});
export function seamFor() {
  const entity = vi.fn(async (id: EntityId) => task(id));
  const connections = vi.fn(async (id: EntityId, opts?: ConnectionOpts): Promise<Page<EdgeView>> => ({
    items: id === TASK ? opts?.direction === 'incoming' ? [edge(session(), taskGuideLines)] : [edge(taskGuideLines, projectPeer)] : [], nextCursor: null,
  }));
  const launch = vi.fn(async (_id: EntityId) => record());
  const projects = vi.fn(async (): Promise<ProjectResource[]> => [{ id: PROJECT, projectEntityId: PROJECT as EntityId, name: 'App',
    repoUrl: 'https://user:PRIVATE_PASSWORD@example.com/app.git?token=PRIVATE_QUERY', trust: 'trusted' as const,
    defaults: {}, createdAt: '', updatedAt: '' }]);
  const credentialList = vi.fn(async () => ({ credentials: [{ id: CREDENTIAL, label: 'Git alice@example.com', displayLogin: 'alice@example.com', status: 'active', keyHint: 'KEY_HINT_SECRET' } as SpaceCredentialView,
    { id: 'new-default', label: 'CURRENT_DEFAULT_MUST_NOT_BE_USED', displayLogin: 'different', status: 'active' } as SpaceCredentialView] }));
  let listener: (() => void) | undefined;
  const unsubscribe = vi.fn();
  const onEvent = vi.fn((cb: () => void) => { listener = cb; return unsubscribe; });
  const seam = { entity, connections, launch, projects, credentials: { space: { list: credentialList } }, onEvent } as unknown as Seam;
  return { seam, entity, connections, launch, projects, credentialList, onEvent, unsubscribe, changed: () => listener?.() };
}
