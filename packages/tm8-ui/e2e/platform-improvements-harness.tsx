import { createRoot } from 'react-dom/client';
import type { AttentionRequest, EdgeView, EntityId, EntitySummary, SessionLaunchRecord, SpaceCredentialView } from '@tm8/contract';
import { createFixtureSeam } from '../src/data/fixtures/seam-fixture';
import type { Seam } from '../src/data/seam';
import { fixtureDetails, sessionStale, taskUuidTitle } from '../src/fixtures';
import { TaskAccessSection } from '../src/task-access/TaskAccessSection';
import { AttentionProvider } from '../src/attention/attention-store';
import { AttentionList } from '../src/attention/AttentionList';
import '../src/styles/tokens.css';
import '../src/styles/canvas-extra.css';
import '../src/styles/app.css';
import '../src/kit/kit.css';
import '../src/panels/panels.css';

// Browser-only SYNTHETIC FIXTURE EVIDENCE. No production data or network writes.
const base = createFixtureSeam();
const task = fixtureDetails[taskUuidTitle.id]!;
const projectId = 'fixture-project' as EntityId;
const credentialId = 'fixture-credential';
const longSegment = 'platform-improvements-recorded-launch-working-directory-with-a-very-long-unbroken-resource-segment';
const project = { ...taskUuidTitle, id: projectId, title: 'Synthetic platform repository', kind: 'project',
  state: { kind: 'project', projectId, materializedVersion: 1 } } as EntitySummary;
const run = { ...sessionStale, title: 'Synthetic recorded run · inherited plan access' };
const edge = (source: EntitySummary, target: EntitySummary) => ({ id: `${source.id}-${target.id}`, source, target }) as EdgeView;
const launch: SessionLaunchRecord = {
  sessionId: run.id, available: true, unavailableReason: null, recordedAt: '2026-11-21T12:00:00.000Z',
  manifest: { session: { workingDirectory: `/synthetic/worktrees/${longSegment}/${longSegment}`, workdirMode: 'worktree' },
    project: { id: projectId }, launch: { accessMode: 'plan', accessModeSource: 'inherited', permissionMode: 'readOnly',
      effectiveCredentialSources: { github: 'space' }, spaceCredentialIds: { github: credentialId },
      commandNetwork: { mode: 'loopback-proxy', allowedHosts: ['127.0.0.1', 'localhost'], portScoped: false } } },
  envVarNames: [], prompts: { system: null, task: null, unavailableReason: 'not_recorded' }, launchContext: null,
  connectorAccounts: { available: true, unavailableReason: null, hiddenCount: 1, entries: [{
    serverId: 'synthetic-drive' as EntityId, serverName: 'Synthetic shared documents connector', credentialRequired: true,
    account: { id: 'opaque-synthetic-account', label: `Synthetic enterprise account ${longSegment}`,
      accountLabel: 'synthetic.person@example.test', grantedScopes: ['documents.readonly', 'drive.metadata.readonly'],
      usable: false, status: 'revoked', reason: 'credential_revoked' },
  }] },
};
const names = { urgent: 'Urgent seen · approve recovery', normal: 'Normal unseen · review the change', fyi: 'FYI · build completed' };
const requests: AttentionRequest[] = (['normal', 'urgent', 'fyi'] as const).map((key) => ({
  id: `synthetic-request-${key}`, spaceId: task.spaceId, entityId: key as EntityId, rootId: key as EntityId,
  reason: names[key], points: key === 'urgent' ? 95 : key === 'normal' ? 40 : 10,
  level: key === 'urgent' ? 'urgent' : key === 'normal' ? 'normal' : 'fyi', seenByMe: key === 'urgent',
  status: 'open', version: 1, requestedBy: task.createdBy!, acknowledgedBy: null, resolvedBy: null,
  resolutionNote: null, createdAt: '2026-11-21T11:00:00.000Z', updatedAt: '2026-11-21T11:00:00.000Z',
  acknowledgedAt: null, resolvedAt: null,
}));
const seam: Seam = {
  ...base,
  entity: async (id) => ({ ...task, id, title: names[id as keyof typeof names] ?? task.title }),
  connections: async (id, options) => ({ items: id !== task.id ? [] : options?.direction === 'incoming'
    ? [edge(run, task)] : [edge(task, project)], nextCursor: null }),
  launch: async () => launch,
  projects: async () => [{ id: projectId, projectEntityId: projectId, name: project.title,
    repoUrl: `https://example.test/synthetic/${longSegment}/${longSegment}.git`,
    trust: 'trusted', defaults: {}, createdAt: '', updatedAt: '' }],
  credentials: { ...base.credentials, space: { ...base.credentials.space,
    list: async () => ({ credentials: [{ id: credentialId, provider: 'github', label: `Synthetic GitHub ${longSegment}`,
      displayLogin: 'synthetic.person@example.test', status: 'active' } as SpaceCredentialView] }) } },
  attentionRequests: async (input) => ({ items: requests.filter((request) => request.status === input.status), nextCursor: null }),
};
const surface = new URLSearchParams(location.search).get('surface');
createRoot(document.getElementById('root')!).render(
  <div className="cv2-root" data-theme="light" style={{ position: 'fixed', inset: 0, overflow: 'auto' }}>
    <main style={{ width: '100%', maxWidth: 980, margin: '0 auto', padding: 16, boxSizing: 'border-box' }}>
      <h1 style={{ fontSize: 18 }}>Synthetic fixture evidence</h1>
      <p>Production task access and attention components with fabricated records for desktop and phone overflow checks.</p>
      {surface !== 'attention' ? <TaskAccessSection seam={seam} taskId={task.id} /> : null}
      {surface !== 'access' ? <AttentionProvider seam={seam} spaceId={task.spaceId} delayMs={0}>
        <AttentionList filter="all" title="Synthetic attention queue" onOpen={() => {}} nameOf={(id) => ({ title: names[id as keyof typeof names] ?? id })} />
      </AttentionProvider> : null}
    </main>
  </div>,
);
