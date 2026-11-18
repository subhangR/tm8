// @vitest-environment jsdom
/**
 * A SLACK BRIDGE, from the wizard to the panel (Slack bridge design §1.2, §1.3).
 *
 * Held here, each with a control that goes red without it:
 * - the channel picker lists Slack's `channel` AND `private_channel` kinds —
 *   the picker filtered to group/self, so every Slack channel fell out of it
 *   (#1504 review); rows read `#name`, a private one carries a lock
 * - the empty list says how to make a channel appear (`/invite @tm8`)
 * - thread mode is on the wizard, defaults to Mention, and rides `bridges.create`
 * - *Every message* is a widening change: it confirms first (§1.5)
 * - thread mode is editable on the Routing tab and saved as a policy patch
 * - WhatsApp-only affordances are hidden on Slack: no QR door, and no
 *   "How replies are signed" where every reply carries its own voice
 * - View in Slack: the channel on the panel, the message in the log, and a
 *   thread reply's link opens the thread
 */
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { BridgeDetailView, BridgeView, EntitySummary } from '@tm8/contract';
import { chatLaunchPlan, channelDesign, teamMemberForge } from '../fixtures/entities';
import { AddBridgeWizard, conversationKindOf, defaultPolicy, testLine } from './AddBridgeWizard';
import { BridgePageBlock } from './BridgePage';
import { RoutingTab } from './tabs/RoutingTab';
import { ConversationTab, rootTsOf } from './tabs/ConversationTab';
import { testPort } from './test-port';
import { FIXTURE_SLACK_ACCOUNT } from './fixture';

afterEach(() => { cleanup(); vi.useRealTimers(); });

const SPACE = 'sp-atelier';
const WIZARD_OPS = [
  'bridges.connections.list', 'bridges.connections.begin', 'bridges.conversations.list', 'bridges.create',
];

function wizardPort() {
  const t = testPort({ served: WIZARD_OPS });
  const port = {
    ...t.port,
    targets: vi.fn(async (): Promise<EntitySummary[]> => [chatLaunchPlan, channelDesign]),
    teammates: vi.fn(async (): Promise<EntitySummary[]> => [teamMemberForge]),
    create: vi.fn(t.client.create),
    conversations: vi.fn(t.client.conversations),
    connections: {
      list: vi.fn(t.client.connections.list),
      begin: vi.fn(t.client.connections.begin),
      offer: vi.fn(t.client.connections.offer),
      withdraw: vi.fn(t.client.connections.withdraw),
      remove: vi.fn(t.client.connections.remove),
    },
  };
  return { ...t, port };
}

/** Open the wizard and get as far as the Slack workspace's channel list. */
async function toChannels() {
  const t = wizardPort();
  const created: BridgeView[] = [];
  render(<AddBridgeWizard port={t.port} spaceId={SPACE} onClose={() => {}} onCreated={(b) => created.push(b)} />);
  const use = await screen.findByRole('button', { name: 'Use Acme Slack' });
  await act(async () => { fireEvent.click(use); });
  const step2 = await screen.findByTestId('wizard-step-conversation');
  await waitFor(() => expect(within(step2).getAllByRole('option').length).toBeGreaterThan(1));
  return { ...t, created, step2 };
}

describe('the defaults for a Slack bridge', () => {
  it('turn thread mode on at @mention, and only for a provider with native threads', () => {
    expect(defaultPolicy('chat', 'channel', 'slack').threadMode).toBe('mention');
    expect(defaultPolicy('work_session', 'channel', 'slack').threadMode).toBe('mention');
    expect(defaultPolicy('chat', 'group', 'whatsapp').threadMode).toBeUndefined();
    expect(defaultPolicy('chat', 'group').threadMode).toBeUndefined();
  });
  it('treat a Slack channel like a group: answer on mention, linked people only', () => {
    expect(defaultPolicy('chat', 'channel', 'slack')).toMatchObject({
      trigger: 'mention', whoMayTrigger: 'linked', outbound: 'replies', direction: 'both',
    });
  });
  it('map each runtime’s conversation kinds onto the bridge’s three', () => {
    expect(conversationKindOf({ kind: 'channel' })).toBe('channel');
    expect(conversationKindOf({ kind: 'private_channel' })).toBe('channel');
    expect(conversationKindOf({ kind: 'group' })).toBe('group');
    expect(conversationKindOf({ kind: 'self' })).toBe('dm');
    expect(conversationKindOf(null)).toBe('group');
  });
});

describe('the channel picker (§1.2)', () => {
  it('lists public and private channels — both of Slack’s kinds', async () => {
    const { step2 } = await toChannels();
    expect(within(step2).getByRole('option', { name: /#deploys/ })).toBeTruthy();
    expect(within(step2).getByRole('option', { name: /#eng-support/ })).toBeTruthy();
    // private_channel: the kind the old group/self filter dropped entirely
    expect(within(step2).getByRole('option', { name: /#incidents/ })).toBeTruthy();
    expect(within(step2).getByText('CHANNELS')).toBeTruthy();
  });

  it('puts one hash on every channel and a lock on the private one', async () => {
    const { step2 } = await toChannels();
    const incidents = within(step2).getByRole('option', { name: /#incidents/ });
    expect(within(incidents).getByLabelText('private channel')).toBeTruthy();
    const support = within(step2).getByRole('option', { name: /#eng-support/ });
    expect(within(support).queryByLabelText('private channel')).toBeNull();
    expect(support.textContent).toContain('#eng-support');
    expect(support.textContent).not.toContain('##');
  });

  it('greys a channel already connected here, with where it goes (D20)', async () => {
    const { step2 } = await toChannels();
    const deploys = within(step2).getByRole('option', { name: /#deploys/ }) as HTMLButtonElement;
    expect(deploys.disabled).toBe(true);
    expect(deploys.textContent).toMatch(/already connected →/);
  });

  it('says to /invite the bot for a channel tm8 is not in', async () => {
    const { step2 } = await toChannels();
    const announce = within(step2).getByRole('option', { name: /#announcements/ });
    expect(announce.textContent).toMatch(/\/invite @tm8 there first/);
  });

  it('tells an admin how to make a channel appear when the list is empty', async () => {
    const t = wizardPort();
    t.port.conversations = vi.fn(async (connectionId: string) => ({ connectionId, items: [] }));
    render(<AddBridgeWizard port={t.port} spaceId={SPACE} onClose={() => {}} onCreated={() => {}} />);
    const use = await screen.findByRole('button', { name: 'Use Acme Slack' });
    await act(async () => { fireEvent.click(use); });
    const empty = await screen.findByTestId('wizard-conversations-empty');
    expect(empty.textContent).toMatch(/only sees a channel it has been invited to/);
    expect(empty.textContent).toContain('/invite @tm8');
  });

  it('asks Slack for channels, not WhatsApp for groups', async () => {
    const { step2 } = await toChannels();
    expect(within(step2).getByLabelText('Search channels')).toBeTruthy();
    expect(step2.textContent).not.toMatch(/WhatsApp/);
  });
});

describe('thread mode in the wizard', () => {
  async function toTarget() {
    const t = await toChannels();
    fireEvent.click(within(t.step2).getByRole('option', { name: /#eng-support/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Next: where it lands' }));
    await screen.findByTestId('wizard-step-target');
    /* This seam serves no chat.start, so there is no *New chat* option: a
       target has to be chosen before Create is live. */
    await waitFor(() => expect(within(screen.getByLabelText('Target')).getAllByRole('option').length).toBe(2));
    fireEvent.change(screen.getByLabelText('Target'), { target: { value: chatLaunchPlan.id } });
    return t;
  }

  it('offers the three modes with Mention chosen', async () => {
    await toTarget();
    const field = screen.getByTestId('bridge-thread-mode');
    expect(within(field).getByRole('radio', { name: /Mention \(default\)/ })).toHaveProperty('checked', true);
    expect(within(field).getByRole('radio', { name: /Every message/ })).toBeTruthy();
    expect(within(field).getByRole('radio', { name: /Off/ })).toBeTruthy();
    expect(field.textContent).toMatch(/child of the bridge's target session/);
    expect(field.textContent).toMatch(/idle after 2 hours/);
  });

  it('rides bridges.create as the policy’s threadMode', async () => {
    const t = await toTarget();
    fireEvent.click(screen.getByRole('button', { name: 'Create bridge' }));
    await waitFor(() => expect(t.port.create).toHaveBeenCalled());
    expect(t.port.create.mock.calls[0]![1]).toMatchObject({
      policy: expect.objectContaining({ threadMode: 'mention' }),
      conversation: expect.objectContaining({ externalId: 'C04SUPPORT', kind: 'channel' }),
    });
  });

  it('asks before *Every message*, saying what it costs (§1.5)', async () => {
    const t = await toTarget();
    fireEvent.click(within(screen.getByTestId('bridge-thread-mode')).getByRole('radio', { name: /Every message/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Create bridge' }));

    const confirm = await screen.findByTestId('bridge-consequences');
    expect(confirm.textContent).toMatch(/EVERY top-level message/);
    expect(confirm.textContent).toMatch(/low-traffic intake channel/);
    expect(t.port.create).not.toHaveBeenCalled();

    await act(async () => { fireEvent.click(within(confirm).getByRole('button', { name: 'Yes, create it' })); });
    expect(t.port.create.mock.calls[0]![1]).toMatchObject({ policy: expect.objectContaining({ threadMode: 'every' }) });
  });

  it('hides the reply-signature switch, because each reply carries its own voice', async () => {
    await toTarget();
    expect(screen.queryByText('How replies are signed')).toBeNull();
    expect(screen.getByTestId('wizard-voice-note').textContent)
      .toMatch(/under the answering session's own name and icon, with no prefix/);
  });

  it('is not offered for a channel mirror, which has no sessions', async () => {
    const t = await toChannels();
    fireEvent.click(within(t.step2).getByRole('option', { name: /#eng-support/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Next: where it lands' }));
    await screen.findByTestId('wizard-step-target');
    fireEvent.click(screen.getByRole('radio', { name: /Channel/ }));
    expect(screen.queryByTestId('bridge-thread-mode')).toBeNull();
  });
});

describe('step 4’s test line', () => {
  it('tells a Slack tester to look in the THREAD', () => {
    expect(testLine('chat', 'Launch plan', 'Slack', 'mention', 'tm8'))
      .toMatch(/answers in a THREAD under your message/);
    expect(testLine('chat', 'Launch plan', 'Slack', 'every', 'tm8')).toMatch(/Now send any message in the channel/);
  });
  it('keeps WhatsApp’s words for WhatsApp', () => {
    expect(testLine('chat', 'Launch plan', 'WhatsApp')).toMatch(/from your phone/);
    expect(testLine('chat', 'Launch plan', 'WhatsApp')).toMatch(/number is verified/);
  });
  it('does not mention threads when thread mode is off', () => {
    expect(testLine('chat', 'Launch plan', 'Slack', 'off', 'tm8')).not.toMatch(/THREAD/);
  });
  it('uses the bot’s real name', () => {
    expect(testLine('work_session', 'forge', 'Slack', 'off', 'acme-bot')).toContain('@acme-bot');
  });
});

describe('thread mode on the Routing tab', () => {
  const slackView = (over: Partial<BridgeView> = {}): BridgeView => {
    const base = testPort().views.find((v) => v.provider === 'slack')!;
    return { ...base, status: 'live', target: { kind: 'chat', id: chatLaunchPlan.id, title: 'Launch plan' }, ...over };
  };

  it('is editable, and saves as a policy patch', async () => {
    const t = testPort({ served: ['bridges.update'] });
    const view = slackView({ policy: { ...slackView().policy, threadMode: 'mention' } });
    render(<RoutingTab view={view} port={t.port} onView={() => {}} />);

    const field = screen.getByTestId('bridge-thread-mode');
    expect(within(field).getByRole('radio', { name: /Mention \(default\)/ })).toHaveProperty('checked', true);
    fireEvent.click(within(field).getByRole('radio', { name: /^Off/ }));
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Save changes' })); });

    expect(t.port.update).toHaveBeenCalledWith(view.id, view.version, { policy: { threadMode: 'off' } });
  });

  it('can turn it on for a bridge whose policy has no threadMode yet', async () => {
    const t = testPort({ served: ['bridges.update'] });
    const { threadMode: _drop, ...policy } = slackView().policy;
    const view = slackView({ policy });
    render(<RoutingTab view={view} port={t.port} onView={() => {}} />);

    fireEvent.click(within(screen.getByTestId('bridge-thread-mode')).getByRole('radio', { name: /^Off/ }));
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Save changes' })); });
    expect(t.port.update).toHaveBeenCalledWith(view.id, view.version, { policy: { threadMode: 'off' } });
  });

  it('confirms a widening change to *Every message*', async () => {
    const t = testPort({ served: ['bridges.update'] });
    const view = slackView({ policy: { ...slackView().policy, threadMode: 'mention' } });
    render(<RoutingTab view={view} port={t.port} onView={() => {}} />);

    fireEvent.click(within(screen.getByTestId('bridge-thread-mode')).getByRole('radio', { name: /Every message/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Save changes' }));
    const confirm = await screen.findByTestId('bridge-consequences');
    expect(confirm.textContent).toMatch(/EVERY top-level message/);
    expect(t.port.update).not.toHaveBeenCalled();
  });

  it('is absent on a WhatsApp bridge', () => {
    const t = testPort({ served: ['bridges.update'] });
    const wa = t.views.find((v) => v.provider === 'whatsapp')!;
    render(<RoutingTab view={wa} port={t.port} onView={() => {}} />);
    expect(screen.queryByTestId('bridge-thread-mode')).toBeNull();
    // …and WhatsApp keeps its signature switch
    expect(screen.getByText('How replies are signed')).toBeTruthy();
  });
});

describe('View in Slack (§1.3)', () => {
  const LINK_OPS = ['bridges.connections.list'];

  it('links the channel from the bridge panel', async () => {
    const t = testPort({ served: LINK_OPS });
    const slack = t.views.find((v) => v.provider === 'slack')!;
    render(
      <BridgePageBlock
        detail={{ id: slack.id, version: slack.version } as never}
        port={t.port}
      />,
    );
    const link = await screen.findByTestId('slack-channel-link') as HTMLAnchorElement;
    expect(link.href).toBe(`${FIXTURE_SLACK_ACCOUNT.url}archives/${slack.conversation.externalId}`);
    expect(link.target).toBe('_blank');
    expect(link.rel).toContain('noreferrer');
  });

  it('draws no link on a WhatsApp bridge', async () => {
    const t = testPort({ served: LINK_OPS });
    const wa = t.views.find((v) => v.provider === 'whatsapp')!;
    render(<BridgePageBlock detail={{ id: wa.id, version: wa.version } as never} port={t.port} />);
    await screen.findByTestId('bridge-header');
    expect(screen.queryByTestId('slack-channel-link')).toBeNull();
  });

  it('links each bridged message by its Slack ts', async () => {
    const t = testPort({ served: LINK_OPS });
    const slack = t.views.find((v) => v.provider === 'slack')!;
    /* A Slack-shaped log: a root and a reply in its thread. */
    const ROOT = '1763462400.123456';
    const REPLY = '1763462500.000200';
    const log = {
      bridgeId: slack.id, logAnchorId: slack.id, more: false, olderCursor: null, lastMessageId: 'm2',
      items: [
        {
          id: 'm1', createdAt: '2026-11-18T09:00:00.000Z', authorId: 'u1', authorKind: 'member', authorName: 'Priya',
          body: '@tm8 the login page 500s', parentMessageId: null, rootMessageId: null, handle: null,
          delivery: null, trust: 'linked' as const,
          origin: { direction: 'in' as const, externalMessageId: ROOT, participant: 'Priya' },
        },
        {
          id: 'm2', createdAt: '2026-11-18T09:01:00.000Z', authorId: 's1', authorKind: 'work_session',
          authorName: 'brave-otter', body: 'On it.', parentMessageId: 'm1', rootMessageId: 'm1', handle: 'brave-otter',
          delivery: null, trust: null,
          origin: { direction: 'out' as const, externalMessageId: REPLY, participant: null },
        },
      ],
    };
    const port = { ...t.port, log: vi.fn(async () => log) };
    render(<ConversationTab view={slack as BridgeDetailView} port={port} />);

    const links = await screen.findAllByTestId('slack-message-link') as HTMLAnchorElement[];
    expect(links).toHaveLength(2);
    // the root: the plain permalink, ts with the dot removed
    expect(links[0]!.href).toBe(`${FIXTURE_SLACK_ACCOUNT.url}archives/${slack.conversation.externalId}/p1763462400123456`);
    // the reply: opens the THREAD at that message
    expect(links[1]!.href).toContain('/p1763462500000200?thread_ts=1763462400.123456&cid=');
  });

  it('resolves a reply’s thread root only when the root is on the page', () => {
    const root = { id: 'm1', rootMessageId: null, origin: { externalMessageId: '1.1' } } as never;
    const reply = { id: 'm2', rootMessageId: 'm1', origin: { externalMessageId: '2.2' } } as never;
    const orphan = { id: 'm9', rootMessageId: 'gone', origin: { externalMessageId: '9.9' } } as never;
    expect(rootTsOf([root, reply], reply)).toBe('1.1');
    expect(rootTsOf([root, reply], root)).toBeNull();
    expect(rootTsOf([root, reply, orphan], orphan)).toBeNull();
  });
});
