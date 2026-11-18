// @vitest-environment jsdom
/**
 * CONNECTING A SLACK WORKSPACE (Slack bridge design §1.1 step 4), and what the
 * Accounts & secrets rows say about it (§4).
 *
 * Held here, each with a control that goes red without it:
 * - TOKEN HYGIENE, the owner's hard rule: both inputs are password inputs with
 *   autocomplete off; Submit clears them whether the call succeeds or fails;
 *   after a submit neither token is anywhere in the DOM — not in a value, an
 *   attribute, an error or a URL; a rotation opens empty, never masked
 * - the pair is checked locally first, against the contract's own regexes, so
 *   a bad paste never travels
 * - begin carries provider 'slack' and the credential, and the connection id
 *   on a rotation
 * - linked is read back from connections.list (the runtime's word) and shows
 *   the workspace auth.test named; a thin install warns which scopes are gone
 * - logged_out shows Slack's error code in words, with a door to paste again
 */
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { BridgeConnectionView } from '@tm8/contract';
import { AccountsBlock } from './AccountsBlock';
import { SlackTokensDialog } from './SlackTokensDialog';
import { testPort } from './test-port';

afterEach(() => { cleanup(); vi.useRealTimers(); });

const SPACE = 'sp-atelier';
const CONNECTION_OPS = [
  'bridges.connections.list', 'bridges.connections.begin', 'bridges.connections.offer',
  'bridges.connections.withdraw', 'bridges.connections.remove',
];

/* Real-looking tokens: they must satisfy the contract's structural regexes,
   and they are long and distinctive so a leak is unmistakable in the DOM. */
/*
 * The tokens in this file are deliberately unrealistic — short, with zero
 * digit groups and a NOTAREAL… body. They still satisfy the contract's
 * regexes, which is all the code under test reads, and they do not look
 * enough like real Slack tokens to trip GitHub's secret scanning (which
 * blocked a push of this branch when they did).
 */
const BOT = 'xoxb-0-0-NOTAREALBOTTOKEN';
const APP = 'xapp-0-A0-0-NOTAREALAPPTOKEN';

function slackPort(served: readonly string[] = CONNECTION_OPS) {
  const t = testPort({ served });
  const port = {
    ...t.port,
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

function openDialog(opts: { relink?: BridgeConnectionView | null } = {}) {
  const t = slackPort();
  const linked: BridgeConnectionView[] = [];
  render(
    <SlackTokensDialog
      port={t.port}
      spaceId={SPACE}
      relink={opts.relink ?? null}
      onClose={() => {}}
      onLinked={(c) => linked.push(c)}
    />,
  );
  return { ...t, linked };
}

const botBox = () => screen.getByLabelText('Bot token') as HTMLInputElement;
const appBox = () => screen.getByLabelText('App-level token') as HTMLInputElement;

function paste(bot: string, app: string) {
  fireEvent.change(botBox(), { target: { value: bot } });
  fireEvent.change(appBox(), { target: { value: app } });
}

/** Every string anywhere in the rendered tree: values, attributes and text. */
function domHaystack(): string {
  const root = document.body;
  const parts: string[] = [root.innerHTML];
  for (const el of Array.from(root.querySelectorAll('input, textarea'))) {
    parts.push((el as HTMLInputElement).value ?? '');
  }
  return parts.join('\n');
}

describe('the Slack token dialog', () => {
  it('uses password inputs that no autofill or manager will touch', () => {
    openDialog();
    for (const box of [botBox(), appBox()]) {
      expect(box.type).toBe('password');
      expect(box.getAttribute('autocomplete')).toBe('off');
      expect(box.getAttribute('spellcheck')).toBe('false');
    }
  });

  it('says where each token lives in the Slack app, and links the setup guide', () => {
    openDialog();
    expect(screen.getByText(/OAuth & Permissions -> Bot User OAuth Token|OAuth & Permissions → Bot User OAuth Token/)).toBeTruthy();
    expect(screen.getByText(/App-Level Tokens/)).toBeTruthy();
    const guide = screen.getByRole('link', { name: 'integrations/slack-bridge/SETUP.md' }) as HTMLAnchorElement;
    expect(guide.href).toContain('integrations/slack-bridge/SETUP.md');
  });

  it('checks the pair locally, so a bad paste never reaches the server', async () => {
    const { port } = openDialog();
    paste('hunter2', APP);
    fireEvent.click(screen.getByRole('button', { name: 'Connect' }));
    expect(await screen.findByTestId('slack-token-problem')).toBeTruthy();
    expect(port.connections.begin).not.toHaveBeenCalled();
  });

  it('names a swapped pair instead of just refusing it', async () => {
    const { port } = openDialog();
    paste(APP, BOT); // the two the other way round: both are valid tokens
    fireEvent.click(screen.getByRole('button', { name: 'Connect' }));
    expect((await screen.findByTestId('slack-token-problem')).textContent).toMatch(/other way round/i);
    expect(port.connections.begin).not.toHaveBeenCalled();
  });

  it('submits provider slack and the credential, and nothing else', async () => {
    const { port } = openDialog();
    paste(BOT, APP);
    fireEvent.change(screen.getByLabelText('Workspace label'), { target: { value: 'Acme Slack' } });
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Connect' })); });
    expect(port.connections.begin).toHaveBeenCalledWith({
      provider: 'slack',
      label: 'Acme Slack',
      credential: { kind: 'slack_tokens', botToken: BOT, appToken: APP },
    });
  });

  it('trims the pasted tokens before sending them', async () => {
    const { port } = openDialog();
    paste(`  ${BOT}\n`, ` ${APP} `);
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Connect' })); });
    expect(port.connections.begin).toHaveBeenCalledWith(expect.objectContaining({
      credential: { kind: 'slack_tokens', botToken: BOT, appToken: APP },
    }));
  });

  /* ------------------------------------------------------------------ *
   * The hard rule: nothing echoes a token back after submit.
   * ------------------------------------------------------------------ */
  it('clears both inputs on submit and leaves no token anywhere in the DOM', async () => {
    openDialog();
    paste(BOT, APP);
    expect(domHaystack()).toContain('NOTAREALBOT'); // it really was in there
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Connect' })); });

    expect(botBox().value).toBe('');
    expect(appBox().value).toBe('');
    const dom = domHaystack();
    expect(dom).not.toContain('NOTAREALBOT');
    expect(dom).not.toContain('NOTAREALAPP');
    expect(dom).not.toContain(BOT);
    expect(dom).not.toContain(APP);
    // and nothing put them in the address bar
    expect(window.location.href).not.toContain('xoxb-');
    expect(window.location.href).not.toContain('xapp-');
  });

  it('clears them on a FAILED submit too, and the refusal never quotes them', async () => {
    const t = slackPort();
    t.port.connections.begin = vi.fn(async () => { throw new Error('the server said no'); });
    render(<SlackTokensDialog port={t.port} spaceId={SPACE} relink={null} onClose={() => {}} onLinked={() => {}} />);
    paste(BOT, APP);
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Connect' })); });

    expect(await screen.findByText('the server said no')).toBeTruthy();
    expect(botBox().value).toBe('');
    expect(appBox().value).toBe('');
    const dom = domHaystack();
    expect(dom).not.toContain('NOTAREALBOT');
    expect(dom).not.toContain('NOTAREALAPP');
  });

  it('never writes a token to storage', async () => {
    openDialog();
    paste(BOT, APP);
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Connect' })); });
    const stores = [window.localStorage, window.sessionStorage];
    for (const store of stores) {
      const dump = Object.keys(store).map((k) => `${k}=${store.getItem(k)}`).join('\n');
      expect(dump).not.toContain('xoxb-');
      expect(dump).not.toContain('xapp-');
    }
  });

  it('opens EMPTY on a rotation — never a masked copy of the sealed pair', async () => {
    const connections = await testPort({ served: CONNECTION_OPS }).client.connections.list();
    const slack = connections.find((c) => c.provider === 'slack')!;
    const { port } = openDialog({ relink: slack });

    expect(screen.getByRole('dialog', { name: `New tokens for ${slack.label}` })).toBeTruthy();
    expect(botBox().value).toBe('');
    expect(appBox().value).toBe('');
    // no label field on a rotation; the connection it rotates is named instead
    expect(screen.queryByLabelText('Workspace label')).toBeNull();

    paste(BOT, APP);
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Use these tokens' })); });
    expect(port.connections.begin).toHaveBeenCalledWith(expect.objectContaining({
      provider: 'slack', connectionId: slack.id,
    }));
    expect(domHaystack()).not.toContain('NOTAREALBOT');
  });
});

describe('what the runtime answers', () => {
  it('shows the workspace auth.test named, and offers it to the space', async () => {
    vi.useFakeTimers();
    const t = slackPort();
    const linked: BridgeConnectionView[] = [];
    render(<SlackTokensDialog port={t.port} spaceId={SPACE} relink={null} onClose={() => {}} onLinked={(c) => linked.push(c)} />);
    paste(BOT, APP);
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Connect' })); });
    /* The fixture settles the tokens on a timer, as a runtime would, and the
       dialog polls connections.list: linked is the RUNTIME's word, never the
       client's. */
    await act(async () => { await vi.advanceTimersByTimeAsync(3000); });

    expect(screen.getByTestId('slack-connected').textContent)
      .toBe('✓ Connected to Acme · Acme Corp (acme.enterprise.slack.com) as @tm8');
    /* …and the space got the offer: `linked` is what the dialog hands back.
       Asserted directly rather than through waitFor, which cannot settle while
       its own timers are faked. */
    expect(linked.map((c) => c.id)).toHaveLength(1);
    expect(linked[0]!.offers.some((o) => o.spaceId === SPACE)).toBe(true);
  });

  it('warns which manifest scopes a thin install is missing', async () => {
    vi.useFakeTimers();
    const t = slackPort();
    render(<SlackTokensDialog port={t.port} spaceId={SPACE} relink={null} onClose={() => {}} onLinked={() => {}} />);
    // the fixture's lever: a bot token ending -noscope links with a trimmed set
    paste('xoxb-0-0-noscope', APP);
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Connect' })); });
    await act(async () => { await vi.advanceTimersByTimeAsync(3000); });

    const warn = screen.getByTestId('slack-missing-scopes');
    expect(warn.textContent).toMatch(/missing 11 scopes/i);
    expect(within(warn).getByText(/chat:write\.customize/)).toBeTruthy();
    expect(within(warn).getByText(/users:read\.email/)).toBeTruthy();
  });

  it('turns Slack’s error code into words, and offers another paste', async () => {
    vi.useFakeTimers();
    const t = slackPort();
    render(<SlackTokensDialog port={t.port} spaceId={SPACE} relink={null} onClose={() => {}} onLinked={() => {}} />);
    paste('xoxb-0-0-invalid', APP);
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Connect' })); });
    await act(async () => { await vi.advanceTimersByTimeAsync(3000); });

    expect(screen.getByTestId('slack-refused').textContent).toMatch(/revoked, rotated or copied/i);
    expect(screen.getByRole('button', { name: 'Paste again' })).toBeTruthy();
    // the inputs are still empty, waiting for a fresh pair
    expect(botBox().value).toBe('');
  });

  it('says so when no Slack runtime is up, rather than waiting silently', async () => {
    const t = slackPort();
    t.port.connections.begin = vi.fn(async () => ({
      connection: (await t.client.connections.list()).find((c) => c.provider === 'slack')!,
      runtime: 'offline' as const,
    }));
    render(<SlackTokensDialog port={t.port} spaceId={SPACE} relink={null} onClose={() => {}} onLinked={() => {}} />);
    paste(BOT, APP);
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Connect' })); });
    expect(await screen.findByText(/No Slack runtime is running/)).toBeTruthy();
  });
});

describe('Accounts & secrets with a Slack workspace', () => {
  beforeEach(() => {
    /* The rows' ⋯ menus use the shared dismiss rule, which needs no clipboard;
       Copy connection id does, so stub it for the whole block. */
    Object.assign(navigator, { clipboard: { writeText: async () => {} } });
  });

  async function openBlock() {
    const t = slackPort();
    render(<AccountsBlock port={t.port} spaceId={SPACE} bridges={t.views} onChanged={() => {}} />);
    await screen.findByTestId('bridges-connections');
    return t;
  }

  it('offers both doors behind + Add an account', async () => {
    await openBlock();
    fireEvent.click(screen.getByTestId('bridges-add-account'));
    const menu = screen.getByRole('menu', { name: 'Add an account' });
    expect(within(menu).getByRole('menuitem', { name: /WhatsApp number/ })).toBeTruthy();
    expect(within(menu).getByRole('menuitem', { name: /Slack workspace/ })).toBeTruthy();
  });

  it('opens the token dialog for Slack and the QR dialog for WhatsApp', async () => {
    await openBlock();
    fireEvent.click(screen.getByTestId('bridges-add-account'));
    fireEvent.click(within(screen.getByRole('menu', { name: 'Add an account' })).getByRole('menuitem', { name: /Slack workspace/ }));
    expect(await screen.findByTestId('bridge-slack-tokens')).toBeTruthy();
    expect(screen.queryByTestId('bridge-link-number')).toBeNull();
  });

  it('names the workspace on the Slack row', async () => {
    const t = await openBlock();
    const slack = (await t.client.connections.list()).find((c) => c.provider === 'slack')!;
    expect(screen.getByTestId(`connection-account-${slack.id}`).textContent)
      .toBe('Connected to Acme · Acme Corp (acme.enterprise.slack.com) as @tm8');
  });

  it('rotates by pasting, and says so in the menu', async () => {
    const t = await openBlock();
    const slack = (await t.client.connections.list()).find((c) => c.provider === 'slack')!;
    fireEvent.click(screen.getByRole('button', { name: `More for ${slack.label}` }));
    const item = screen.getByRole('menuitem', { name: /Paste new tokens for Acme Slack/ });
    fireEvent.click(item);
    expect(await screen.findByTestId('bridge-slack-tokens')).toBeTruthy();
    expect((screen.getByLabelText('Bot token') as HTMLInputElement).value).toBe('');
  });

  it('keeps Re-link for a WhatsApp number', async () => {
    const t = await openBlock();
    const wa = (await t.client.connections.list()).find((c) => c.provider === 'whatsapp')!;
    fireEvent.click(screen.getByRole('button', { name: `More for ${wa.label}` }));
    expect(screen.getByRole('menuitem', { name: `Re-link ${wa.label}` })).toBeTruthy();
  });

  it('says what removing a Slack workspace does, not what WhatsApp does', async () => {
    const t = await openBlock();
    const slack = (await t.client.connections.list()).find((c) => c.provider === 'slack')!;
    fireEvent.click(screen.getByRole('button', { name: `More for ${slack.label}` }));
    fireEvent.click(screen.getByRole('menuitem', { name: `Remove ${slack.label}…` }));
    const dialog = await screen.findByTestId('bridge-consequences');
    expect(dialog.textContent).toMatch(/Socket Mode connection stops and the sealed tokens are deleted/);
    expect(dialog.textContent).not.toMatch(/WhatsApp logs this device out/);
  });
});
