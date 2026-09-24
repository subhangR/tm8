import { useState } from 'react';
import { createRoot } from 'react-dom/client';
import type {
  CredentialsSpacePolicyView,
  EntityId,
  SessionJournalPage,
  SessionLaunchRecord,
  SessionTranscriptPage,
  SpaceCredentialView,
} from '@tm8/contract';
import './styles/tokens.css';
import './styles/canvas-extra.css';
import './styles/app.css';
import './kit/kit.css';
import './shell/shell.css';
import { NodeCredentialsSection, SpaceCredentialsSection, type SpaceCredentialsPort } from './settings-credentials';
import { LaunchSheet } from './views/LaunchSheet';
import { LAUNCH_CAPACITY, LAUNCH_PROFILES, LAUNCH_PROJECTS, LAUNCH_TEAMMATES } from './views/launch-fixtures';
import { SessionDebugBody } from './panels/bodies/SessionDebugBody';
import type { Seam } from './data/seam';

/**
 * SPACE CREDENTIALS SCRATCH HARNESS (SC-5) — the `credsetup-dev` pattern, for
 * what no vitest here can settle: what the four SC-5 surfaces LOOK like.
 *
 *   /spacecreds-dev.html?view=settings            Settings → Space credentials (admin)
 *   /spacecreds-dev.html?view=settings&as=member  … as a member who created none (D11)
 *   /spacecreds-dev.html?view=node                Settings → Node credentials (node admin)
 *   /spacecreds-dev.html?view=picker              the launch sheet's credential rows
 *   /spacecreds-dev.html?view=session             a session's launch facts (D8/D9)
 *
 * Everything is in memory. No key exists anywhere in this file (I5).
 */
const SPACE = 'space-dev';
const params = new URLSearchParams(window.location.search);
const view = params.get('view') ?? 'settings';
const asMember = params.get('as') === 'member';

const at = '2026-09-20T09:30:00.000Z';
function row(over: Partial<SpaceCredentialView> & Pick<SpaceCredentialView, 'id' | 'provider' | 'label'>): SpaceCredentialView {
  return {
    spaceId: SPACE, shape: over.provider === 'github' ? 'token' : 'api_key', isDefault: false, status: 'active',
    createdByAccountId: 'acct-me', displayLogin: null, keyHint: null,
    createdAt: at, updatedAt: at, lastUsedAt: null, lastProbeAt: at, ...over,
  } as SpaceCredentialView;
}
const rows: SpaceCredentialView[] = [
  row({ id: 'c-team', provider: 'anthropic', label: 'Team Claude', isDefault: true, lastUsedAt: '2026-09-23T21:04:00.000Z' }),
  row({ id: 'c-batch', provider: 'anthropic', label: 'Batch Claude', createdByAccountId: 'acct-other', lastUsedAt: '2026-09-22T16:40:00.000Z' }),
  row({ id: 'c-login', provider: 'anthropic', label: 'Max plan login', status: 'pending', createdByAccountId: 'acct-other' }),
  row({ id: 'o-shared', provider: 'openai', label: 'Shared Codex', status: 'stale', createdByAccountId: null }),
  row({ id: 'g-bot', provider: 'github', label: 'Release bot', isDefault: true, displayLogin: 'tm8-release-bot' }),
];
let policy: CredentialsSpacePolicyView = {
  spaceId: SPACE,
  providers: [{ provider: 'openai', allowedSources: ['space', 'node'] }],
  node: [{ provider: 'github', allowNode: false }],
};

const port: SpaceCredentialsPort = {
  viewer: async () => ({ accountId: 'acct-me', isSpaceAdmin: !asMember, isNodeAdmin: !asMember }),
  list: async () => rows.filter((r) => !(asMember && r.status === 'pending' && r.createdByAccountId !== 'acct-me')),
  create: async (input) => row({ id: `n-${rows.length}`, provider: input.provider, label: input.label }),
  rekey: async (id) => rows.find((r) => r.id === id)!,
  rename: async (id, label) => ({ ...rows.find((r) => r.id === id)!, label }),
  setDefault: async (id) => ({ ...rows.find((r) => r.id === id)!, isDefault: true }),
  remove: async (id) => ({ credentialId: id, revoked: true, terminatedLoginSessionIds: [], terminatedAgentSessionIds: [], failures: [] }),
  policy: async () => policy,
  setPolicy: async (provider, allowedSources) => {
    policy = { ...policy, providers: [...policy.providers.filter((p) => p.provider !== provider), { provider, allowedSources }] };
    return { spaceId: SPACE, provider, allowedSources };
  },
  nodeStatus: async () => ({
    providers: [
      { provider: 'anthropic', envKeyPresent: true, allowNode: null },
      { provider: 'openai', envKeyPresent: false, allowNode: null },
      { provider: 'github', envKeyPresent: true, allowNode: false },
    ],
  }),
  setNodePolicy: async (provider, allowNode) => ({ provider, allowNode }),
} as SpaceCredentialsPort;

const SESSION = '01a0d0aa-0000-7000-8000-000000000001';
const launchRecord = {
  sessionId: SESSION, available: true, unavailableReason: null,
  manifest: {
    manifestVersion: '1', sessionId: SESSION, spaceId: SPACE, generatedAt: at, mode: 'worker',
    agent: { teamMemberId: 'tm-1', name: 'Draco', role: 'engineer', identity: '' },
    launch: {
      tool: 'claude-code', model: 'opus', permissionMode: 'acceptEdits', accessMode: 'auto', reasoningEffort: 'high',
      credentialSources: { anthropic: 'space', github: 'space' },
      effectiveCredentialSources: { anthropic: 'space', openai: 'node', github: 'space' },
      spaceCredentialIds: { anthropic: 'c-batch', github: 'g-bot' },
      commandNetwork: { mode: 'loopback-proxy', allowedHosts: ['127.0.0.1'] },
      command: "claude --model 'opus'",
    },
    session: { title: 'Fix the resize race', workingDirectory: '/work/tm8', workdirMode: 'project' },
    tasks: [{ id: 'tk-1', title: 'Fix the resize race' }],
  },
  envVarNames: ['TM8_BASE_URL', 'TM8_SESSION_ID'],
  prompts: { system: null, task: null, unavailableReason: 'not_recorded' },
  recordedAt: at,
} as unknown as SessionLaunchRecord;
const seam = {
  launch: async () => launchRecord,
  journal: async () => ({
    sessionId: SESSION, available: true, unavailableReason: null, records: [], hasMore: false,
    totals: { invocations: 0, failed: 0, agentToCliEst: 0, cliToAgentEst: 0, estimator: 'chars/4', malformed: 0 },
  } as unknown as SessionJournalPage),
  transcript: async () => ({
    sessionId: SESSION, available: false, unavailableReason: 'not_recorded', agentTool: 'claude-code', entries: [],
    stats: null, stuck: null, lastActivityAt: null, malformed: 0,
  } as unknown as SessionTranscriptPage),
  credentials: { space: { list: async (spaceId: string) => ({ spaceId, credentials: rows }) } },
} as unknown as Seam;

function Harness() {
  const [theme, setTheme] = useState<'light' | 'dark'>(params.get('theme') === 'dark' ? 'dark' : 'light');
  return (
    <div className="cv2-root shell-scope" data-theme={theme} style={{ minHeight: '100vh', background: 'var(--pn-bg)' }}>
      <div style={{ padding: 16, maxWidth: 760, position: 'relative', minHeight: '100vh' }}>
        <button type="button" onClick={() => setTheme((t) => (t === 'light' ? 'dark' : 'light'))}>theme: {theme}</button>
        {view === 'settings' ? <SpaceCredentialsSection port={port} /> : null}
        {view === 'node' ? <NodeCredentialsSection port={port} /> : null}
        {view === 'session' ? <SessionDebugBody seam={seam} sessionId={SESSION} live={false} /> : null}
        {view === 'picker' ? (
          <LaunchSheet
            subjectId={'task-1' as EntityId}
            fromChip="◔ Run ▸"
            fromCaption="task pre-associated"
            teammates={LAUNCH_TEAMMATES}
            projects={LAUNCH_PROJECTS}
            profiles={LAUNCH_PROFILES}
            capacity={LAUNCH_CAPACITY}
            spaceId={SPACE}
            loadSpaceCredentials={async (spaceId) => ({ spaceId, credentials: rows })}
            loadSpacePolicy={async () => ({ ...policy, providers: [{ provider: 'anthropic', allowedSources: ['space', 'node'] }] })}
            onLaunch={() => {}}
            onCancel={() => {}}
          />
        ) : null}
      </div>
    </div>
  );
}

createRoot(document.getElementById('root')!).render(<Harness />);
