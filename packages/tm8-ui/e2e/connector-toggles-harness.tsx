/**
 * §10.0/§10.4/§10.5/§10.6 — THE TOGGLE SURFACES, IN A REAL BROWSER.
 *
 * jsdom loads no stylesheet and rasterizes nothing, so every assertion in the
 * unit suites is blind to the thing most likely to be wrong here: a row list
 * that is structurally perfect and renders at the wrong scale, overflows the
 * popover it sits in, or draws its status column off the edge. This harness
 * exists to be LOOKED AT — it mounts the production components with the
 * production CSS and a catalog that holds one row per §10.0 status, including
 * the ones a healthy Space never shows.
 *
 * It is a fixture harness and makes no claim beyond layout: the seam is proved
 * separately, against a real facade and a real database, in
 * `packages/server/test/db/mcp-requests-and-chat-selections.pg.test.ts`.
 */
import React, { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { McpProvider } from '../src/mcp/context';
import { ConnectorToggleList } from '../src/mcp/ConnectorToggleList';
import { McpPicker } from '../src/mcp/McpPicker';
import { AddToTurnMenu } from '../src/chat-home/composer/AddToTurnMenu';
import {
  CODEX_CONNECTORS_REASON,
  ChatConnectorsSheet,
  ConnectorsChip,
  useChatConnectors,
} from '../src/chat-home/composer/ChatConnectors';
import type { McpAccount, McpCatalog, McpPort, McpSelection, McpServer } from '../src/mcp/port';
// THE REAL STYLESHEETS, in the app's own order. Without the tokens every
// `var(--pn-…)` falls back to nothing and the popovers render as transparent
// text over the page — which is a defect in the HARNESS, and would be read as
// a defect in the component by anyone looking at the result.
import '../src/styles/tokens.css';
import '../src/styles/app.css';
import '../src/kit/kit.css';
import '../src/panels/panels.css';
import '../src/chat-home/chat-home.css';
import '../src/panels/bodies/session-debug.css';
import '../src/new-session/new-session.css';

const account = (over: Partial<McpAccount> = {}): McpAccount => ({
  id: 'work', label: 'work@example.com', ownerId: 'me', ownerLabel: 'You',
  canUse: true, canManage: true, status: 'connected', sharing: 'private', ...over,
});
const server = (over: Partial<McpServer>): McpServer => ({
  id: 'x', version: 1, title: 'Connector', description: '', transport: 'http',
  url: 'https://example.test/mcp', auth: 'api_key', approved: true, enabled: true,
  canManage: true, canApprove: true, canAttach: true, accounts: [account()], ...over,
});

/** One row per §10.0 status, so no state is unseen. */
const data: McpCatalog = {
  canRegister: true,
  canAttach: true,
  defaults: [{ serverId: 'gmail' }, { serverId: 'calendar' }],
  servers: [
    server({ id: 'gmail', title: 'Gmail', description: 'Read and send mail', auth: 'oauth' }),
    server({ id: 'calendar', title: 'Google Calendar', description: 'Events and availability', auth: 'oauth',
      accounts: [account({ id: 'work' }), account({ id: 'personal', label: 'personal@example.com' })] }),
    server({ id: 'figma', title: 'Figma', description: 'Frames and components', auth: 'oauth',
      accounts: [account({ id: 'shared', label: 'Design team', ownerId: undefined, ownerLabel: 'Shared with Space', status: 'needs_reconnect', canUse: false })] }),
    server({ id: 'linear', title: 'Linear', description: 'Issues and cycles', auth: 'api_key', accounts: [] }),
    server({ id: 'notion', title: 'Notion', description: 'Pages and databases', auth: 'oauth', approved: false, accounts: [] }),
    server({ id: 'slack', title: 'Slack', description: 'Channels and messages', auth: 'api_key', enabled: false }),
    server({ id: 'docs', title: 'internal-docs', description: 'No account needed', auth: 'none', accounts: [] }),
    server({ id: 'localtool', title: 'local-indexer', description: 'Runs on this node', transport: 'stdio',
      command: 'tm8-indexer', auth: 'none', accounts: [],
      source: { name: 'local-indexer', transport: 'stdio', command: 'tm8-indexer', args: [], stdioTrusted: false,
        approved: true, enabled: true, envKeys: [], headerKeys: [], auth: { type: 'none' } } as McpServer['source'] }),
    server({ id: 'unreachable', title: 'Sentry', description: 'Issues and releases', auth: 'api_key',
      health: { ready: false, reason: 'server_unavailable', tools: [], checkedAt: new Date().toISOString() } }),
  ],
};

const port: McpPort = {
  catalog: async () => structuredClone(data),
  register: async () => {}, update: async () => {}, remove: async () => {}, importConfig: async () => {},
  attach: async () => {}, detach: async () => {},
  test: async () => ({ ok: true, message: 'ready', tools: [] }),
  createKey: async () => {}, rotateKey: async () => {},
  startOAuth: async () => ({ authorizationUrl: 'https://identity.example/authorize' }),
  share: async () => {}, revoke: async () => {}, members: async () => [],
  chatSelections: async () => null,
  setChatSelections: async (_chatId, value) => value,
  sessionProvenance: async (sessionId) => ({
    sessionId, recorded: true,
    rootMemberId: '019f0000-0000-7000-8000-0000000000a1',
    rootIdentityId: 'ada',
    chain: ['019f0000-0000-7000-8000-0000000000b1', '019f0000-0000-7000-8000-0000000000b2'],
    chainSpaceIds: ['019f0000-0000-7000-8000-0000000000c1', '019f0000-0000-7000-8000-0000000000c2'],
    depth: 2,
    launcherIdentityId: 'ada', launcherAuthKind: 'browser',
    rootStillAdmitted: false,
  }),
};

function Block({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section style={{ padding: 20, borderTop: '1px solid #ddd8ce' }}>
      <h2 style={{ font: '600 13px system-ui', letterSpacing: '.08em', textTransform: 'uppercase', color: '#6b6457' }}>{title}</h2>
      {children}
    </section>
  );
}

function App() {
  const chat = useChatConnectors('019f0000-0000-7000-8000-0000000000d1');
  const [launch, setLaunch] = useState<McpSelection[] | undefined>();
  const [readOnly, setReadOnly] = useState<McpSelection[] | undefined>([{ serverId: 'gmail' }, { serverId: 'figma' }]);
  return (
    <main>
      <Block title="§10.4 chat — the ＋ sheet and the chip">
        <div className="tch-composer" style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
          <AddToTurnMenu
            enabledSkills={[]}
            onToggleSkill={() => {}}
            connectors={<ChatConnectorsSheet state={chat} />}
          />
          <ConnectorsChip state={chat} />
          <span style={{ font: '13px system-ui', color: '#6b6457' }}>← open ＋, then Connectors; the chip opens the same body</span>
        </div>
      </Block>
      <Block title="§10.4 chat — G13, a Codex lane">
        <AddToTurnMenu
          testId="tch-add-codex"
          enabledSkills={[]}
          onToggleSkill={() => {}}
          connectorsReason={CODEX_CONNECTORS_REASON}
        />
      </Block>
      <Block title="§10.4 chat — the sheet body at full width">
        <ChatConnectorsSheet state={chat} testId="tch-connectors-wide" />
      </Block>
      <Block title="§10.5 launch — the collapsed summary and the grid">
        <McpPicker
          value={launch}
          onChange={setLaunch}
          layout="grid"
          notice="Full restores plugins and skills, not your Claude connectors. Connectors come from this list."
        />
      </Block>
      <Block title="§10.6 debug — the read-only record">
        <div className="pn-debug">
          <ConnectorToggleList
            catalog={data}
            value={readOnly}
            onChange={setReadOnly}
            readOnly
            testId="mcp-readonly"
          />
        </div>
      </Block>
    </main>
  );
}

/*
 * ONE `.cv2-root`, AND EXACTLY ONE.
 *
 * Every design token is scoped to this class (`styles/tokens.css`) and the
 * class also carries `zoom: 1.1` (`styles/app.css`), so a harness without it
 * renders with no colours, no borders and at the wrong scale — which is what
 * the first run of this file did, and it made a perfectly fine popover look
 * like an unstyled bleed over the page. A SECOND, nested one would be the
 * opposite mistake: `zoom` MULTIPLIES down the ancestor chain, and that is how
 * the terminal spent weeks rendering at 1.21x behind a counter-scale that
 * looked right in isolation. `useMenuAnchor` portals into the nearest
 * `.cv2-root`, so the popovers below land inside this scope exactly as they do
 * in the app.
 */
createRoot(document.getElementById('root')!).render(
  <div className="cv2-root">
    <McpProvider port={port}><App /></McpProvider>
  </div>,
);
