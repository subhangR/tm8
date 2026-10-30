/**
 * Bridge fixtures (392, B0a): one live WhatsApp group bridged to a chat, the
 * shape `internal.bridge_view` answers. B1 and the CLI tests build on these.
 */
import type { BridgeDetailView, BridgeFacts, BridgePolicy, BridgeView } from '../../src/index.js';

export const FIXTURE_BRIDGE_POLICY: BridgePolicy = {
  trigger: 'mention', direction: 'both', outbound: 'replies', whoMayTrigger: 'linked', voice: 'named', style: null,
};

export const FIXTURE_BRIDGE_FACTS: BridgeFacts = {
  provider: 'whatsapp',
  connectionId: '01a189da-0000-7000-8000-000000000001',
  connectionCredentialId: null,
  conversation: { externalId: '120363000000000000@g.us', kind: 'group', title: 'Infra', memberCount: 7 },
  target: { kind: 'chat', id: '01a189da-0000-7000-8000-000000000002', title: 'Infra main' },
  policy: FIXTURE_BRIDGE_POLICY,
  status: 'live',
  health: { connection: 'linked', lastInboundAt: null, lastOutboundAt: null, queued: 0, failed24h: 0, detail: null },
  people: { participants: 0, linked: 0, guestsSeen7d: 0 },
  handles: 0,
  retentionDays: null,
  teammateId: '01a189da-0000-7000-8000-000000000003',
  purpose: 'Infra on-call',
  quietHours: null,
  workerPosting: true,
  workers: { wake: 'directed' },
  pausedAt: null,
  endedAt: null,
};

export const FIXTURE_BRIDGE_VIEW: BridgeView = {
  ...FIXTURE_BRIDGE_FACTS,
  id: '01a189da-0000-7000-8000-000000000004',
  spaceId: '01a189da-0000-7000-8000-000000000005',
  version: 1,
  title: 'Infra',
  createdAt: '2026-10-29T22:00:00.000Z',
  updatedAt: '2026-10-29T22:00:00.000Z',
};

export const FIXTURE_BRIDGE_DETAIL: BridgeDetailView = { ...FIXTURE_BRIDGE_VIEW, recentPosters: [] };
