// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, waitFor, within } from '@testing-library/react';
import type { ActionRows, EntityDetail, ServerView } from '@tm8/contract';
import { REASONS, getKind, type ActionContext } from '../../domain';
import { FIXTURE_SPACE_ID, credentialTeamKey, fixtureDetails } from '../../fixtures';
import { createFixtureSeam } from '../../data/fixtures/seam-fixture';
import { managedPortFromSeam, type ManagedPort, type ManagedRecord } from '../../managed/port';
import { EntityDetailPanel } from '../index';

/**
 * THE MANAGED PANELS (task 01a0e24d) — credential, space_link and server.
 *
 * Mounted through `EntityDetailPanel`, never `ManagedBlock` by hand, so the
 * registry row's `{ block: 'managed' }` is what routes here: drop it and the
 * panel falls back to `block-fields` and every case below reds.
 *
 * The panel decides NOTHING about permission. Each case feeds `actions.list`
 * rows the way the server would shape them and asserts the panel says what
 * those rows say:
 *   · listed                → a live control;
 *   · listed, `refused`     → "Only a person can do this" (an agent caller);
 *   · unlisted              → the registry's reason, or for a read, nothing.
 */

const ctx: ActionContext = { spaceId: FIXTURE_SPACE_ID };
const PRIVATE_OTHER = '0f1e2d3c-0000-4000-8000-000000000c02';
const PUBLIC_MINE = '0f1e2d3c-0000-4000-8000-000000000c01';
const LINK = '0f1e2d3c-0000-4000-8000-000000000d01';
const SERVER = '0f1e2d3c-0000-4000-8000-0000000000f1';

const base = fixtureDetails[credentialTeamKey.id] as EntityDetail;

function detailOf(kind: 'credential' | 'space_link' | 'server', id: string): EntityDetail {
  const content = kind === 'credential' ? base.content : { kind };
  const state = kind === 'credential' ? base.state : { kind };
  return { ...base, id, kind, title: `${kind} ${id.slice(-3)}`, content, state } as EntityDetail;
}

/** An `actions.list` answer: `listed` ops as rows, `refused` ones flagged as the server flags an agent's human-only row. */
function rowsOf(listed: readonly string[], refused: readonly string[] = [], human = refused.length === 0): ActionRows {
  const rows = listed.map((op): ActionRows['rows'][number] =>
    refused.includes(op)
      ? [op as ActionRows['rows'][number][0], 'update', 'entity', 'public', true]
      : [op as ActionRows['rows'][number][0], 'update', 'entity', 'public']);
  return {
    schema: 'tm8.actions.v2', human, actorId: 'm-ada', target: { id: 'x', kind: 'credential', version: 1 },
    capabilityEpoch: 'cap:test', columns: ['operation', 'kind', 'authzTarget', 'exposure', 'refused'], rows, total: rows.length,
  } as ActionRows;
}

/** The fixture seam's real port, with `actions` (and optionally the record) scripted per case. */
function portWith(rows: ActionRows, record?: ManagedRecord | null): ManagedPort {
  const port = managedPortFromSeam(createFixtureSeam());
  return {
    ...port,
    actions: async () => rows,
    ...(record !== undefined ? { read: async () => record } : {}),
    run: vi.fn(port.run),
    startLogin: vi.fn(port.startLogin),
  };
}

async function mount(detail: EntityDetail, port: ManagedPort) {
  const view = render(
    <EntityDetailPanel detail={detail} reasons={REASONS} ctx={ctx} commands={{ managed: port } as never} />,
  );
  await waitFor(() => expect(view.getByTestId('managed-block')).toBeTruthy());
  return view;
}

const credVerbs = () => getKind('credential').panel.managed!.verbs.map((v) => v.operation);
const linkVerbs = () => getKind('space_link').panel.managed!.verbs.map((v) => v.operation);

describe('the registry routes the three kinds to the managed block', () => {
  it.each(['credential', 'space_link', 'server'] as const)('%s declares a managed block and spec', (kind) => {
    const panel = getKind(kind).panel;
    expect(panel.blocks?.some((b) => b.block === 'managed')).toBe(true);
    expect(panel.managed).toBeTruthy();
  });
});

describe('ac_3 — verbs follow actions.list, not the kind', () => {
  it('a listed credential verb is live; an unlisted one carries the registry reason', async () => {
    const view = await mount(detailOf('credential', PUBLIC_MINE), portWith(rowsOf(['credentials.space.rename'])));
    const rename = view.getByTestId('managed-verb-credentials.space.rename');
    expect(rename.tagName).toBe('BUTTON');
    const revoke = view.getByTestId('managed-verb-credentials.space.delete');
    expect(revoke.tagName).toBe('SPAN');
    expect(view.getByText(/Only its owner or a space admin can revoke it/)).toBeTruthy();
  });

  it('the usage read is not drawn at all while unlisted, and is drawn when listed', async () => {
    const hidden = await mount(detailOf('credential', PUBLIC_MINE), portWith(rowsOf(credVerbs())));
    expect(hidden.queryByTestId('managed-read-credentials.space.usage')).toBeNull();
    hidden.unmount();
    const shown = await mount(detailOf('credential', PUBLIC_MINE), portWith(rowsOf([...credVerbs(), 'credentials.space.usage'])));
    await waitFor(() => expect(shown.getByTestId('managed-read-credentials.space.usage')).toBeTruthy());
  });

  it('a live verb runs its operation against this record', async () => {
    const port = portWith(rowsOf(['credentials.space.myDefault.set']));
    const view = await mount(detailOf('credential', PUBLIC_MINE), port);
    await act(async () => { fireEvent.click(view.getByTestId('managed-verb-credentials.space.myDefault.set')); });
    expect(port.run).toHaveBeenCalledWith('credentials.space.myDefault.set', { id: PUBLIC_MINE, spaceId: FIXTURE_SPACE_ID }, undefined);
  });
});

describe('ac_5 — an agent sees a human-only verb refused, with the reason', () => {
  it('credential: a refused row renders "Only a person can do this", not a control', async () => {
    const view = await mount(
      detailOf('credential', PUBLIC_MINE),
      portWith(rowsOf(['credentials.space.setVisibility'], ['credentials.space.setVisibility'])),
    );
    const slot = view.getByTestId('managed-verb-credentials.space.setVisibility');
    expect(slot.tagName).toBe('SPAN');
    const group = slot.closest('.hon-disabled-group') as HTMLElement;
    expect(within(group).getByText(/Only a person can do this/)).toBeTruthy();
    expect(within(group).getByText(/ask your human to do it/)).toBeTruthy();
  });

  it('space link: a refused row renders "Only a person can do this", not a control', async () => {
    const view = await mount(detailOf('space_link', LINK), portWith(rowsOf(['spaceLinks.login'], ['spaceLinks.login'])));
    const slot = view.getByTestId('managed-verb-spaceLinks.login');
    expect(slot.tagName).toBe('SPAN');
    const group = slot.closest('.hon-disabled-group') as HTMLElement;
    expect(within(group).getByText(/Only a person can do this/)).toBeTruthy();
  });
});

describe('ac_6 — no widened masking', () => {
  it("the fixture seam masks a private credential's hint and login from a viewer who does not own it", async () => {
    const seam = createFixtureSeam();
    const row = (await seam.credentials.space.list(FIXTURE_SPACE_ID)).credentials.find((c) => c.id === PRIVATE_OTHER);
    expect(row?.keyHint).toBeNull();
    expect(row?.displayLogin).toBeNull();
  });

  it('a non-owner sees neither key hint nor login on a private credential, and the owner word is not a name', async () => {
    const view = await mount(detailOf('credential', PRIVATE_OTHER), portWith(rowsOf([])));
    expect(view.getByTestId('managed-fact-label')).toBeTruthy();
    expect(view.queryByTestId('managed-fact-keyHint')).toBeNull();
    expect(view.queryByTestId('managed-fact-displayLogin')).toBeNull();
    expect(view.queryByText('Pv8c')).toBeNull();
    expect(view.queryByText('other-login')).toBeNull();
    expect(view.getByTestId('managed-owner').textContent).toBe('Owned by someone else');
  });

  it("the owner of a public credential does see its hint and login (the panel hides nothing the server shows)", async () => {
    const view = await mount(detailOf('credential', PUBLIC_MINE), portWith(rowsOf([])));
    expect(view.getByTestId('managed-fact-keyHint').textContent).toContain('k3Jd');
    expect(view.getByTestId('managed-fact-displayLogin').textContent).toContain('tm8-bot');
    expect(view.getByTestId('managed-owner').textContent).toBe('You');
  });

  it('credential copy never says "node" or "member"', () => {
    const spec = getKind('credential').panel.managed!;
    const copy = JSON.stringify([spec.verbs, spec.facts, spec.owner, spec.loginTerminal, spec.reads, spec.notices]);
    expect(copy).not.toMatch(/\bnode\b|\bmember\b/i);
  });
});

describe('ac_7 — the server panel says remote forwarding is off, and why', () => {
  it('renders the notice with its reason', async () => {
    const server: ServerView = {
      id: SERVER, homeSpaceId: FIXTURE_SPACE_ID, name: 'Lab box', baseUrl: 'https://lab.example', username: null,
      reachStatus: 'unknown', reachCheckedAt: null, legacyConnectionId: null, createdAt: base.createdAt, updatedAt: base.updatedAt, mine: null,
    };
    const view = await mount(detailOf('server', SERVER), portWith(rowsOf(['servers.probe']), server));
    const notice = view.getByTestId('managed-notice');
    expect(notice.textContent).toMatch(/Remote forwarding is off/);
    expect(notice.textContent).toMatch(/remote_links_disabled/);
    expect(notice.textContent).toMatch(/code change, not a setting/);
    expect(view.getByTestId('managed-fact-reachStatus').textContent).toContain('Not checked yet');
    expect(view.getByTestId('managed-verb-servers.probe').tagName).toBe('BUTTON');
  });
});

describe('ac_8 — the login terminal is reachable inline', () => {
  const loginShaped = async () => {
    const seam = createFixtureSeam();
    const row = (await seam.credentials.space.list(FIXTURE_SPACE_ID)).credentials.find((c) => c.id === PUBLIC_MINE)!;
    return { ...row, provider: 'anthropic', shape: 'login' } as ManagedRecord;
  };

  it('"Log in again" opens the terminal inside the panel, for this credential', async () => {
    const port = portWith(rowsOf(['credentials.loginSessions.start']), await loginShaped());
    port.startLogin = vi.fn(async () => ({
      workSessionId: 'ws-login', spaceId: FIXTURE_SPACE_ID, provider: 'anthropic', expiresAt: base.updatedAt, command: 'claude login',
    })) as ManagedPort['startLogin'];
    const view = await mount(detailOf('credential', PUBLIC_MINE), port);
    await act(async () => { fireEvent.click(view.getByTestId('managed-verb-credentials.loginSessions.start')); });
    expect(port.startLogin).toHaveBeenCalledWith({ id: PUBLIC_MINE, spaceId: FIXTURE_SPACE_ID }, 'anthropic');
    await waitFor(() => expect(view.getByTestId('managed-login-terminal')).toBeTruthy());
  });

  it('is not offered on a credential that is not login-shaped', async () => {
    const view = await mount(detailOf('credential', PUBLIC_MINE), portWith(rowsOf(['credentials.loginSessions.start'])));
    expect(view.queryByTestId('managed-verb-credentials.loginSessions.start')).toBeNull();
  });
});

describe('space link verbs act on the caller\'s own sign-in', () => {
  it('Remove asks first, and says only your sign-in goes', async () => {
    const port = portWith(rowsOf(linkVerbs()));
    const view = await mount(detailOf('space_link', LINK), port);
    await act(async () => { fireEvent.click(view.getByTestId('managed-verb-spaceLinks.remove')); });
    expect(view.getByTestId('managed-confirm-spaceLinks.remove').textContent).toMatch(/Everyone else keeps theirs/);
    expect(port.run).not.toHaveBeenCalledWith('spaceLinks.remove', expect.anything(), undefined);
  });

  it('the spawn flip offers the opposite of the current setting', async () => {
    const view = await mount(detailOf('space_link', LINK), portWith(rowsOf(linkVerbs())));
    expect(view.getByTestId('managed-verb-spaceLinks.setSpawn').textContent).toBe('Let agents start sessions there');
  });
});

describe('the credential page (task 01a18e53): header, details, lifecycle, states', () => {
  const record = (over: Partial<Record<string, unknown>> = {}) => ({
    id: PUBLIC_MINE, spaceId: FIXTURE_SPACE_ID, provider: 'anthropic', shape: 'api_key', label: 'Team key',
    isDefault: false, status: 'active', createdByAccountId: null, displayLogin: null, keyHint: 'k3Jd',
    createdAt: '2026-09-01T10:00:00.000Z', updatedAt: '2026-10-01T10:00:00.000Z',
    lastUsedAt: null, lastProbeAt: '2026-10-30T10:00:00.000Z', ownerAccountId: null, visibility: 'public', ...over,
  }) as ManagedRecord;

  it('the header names provider, kind, status and owner, and DETAILS does not repeat them', async () => {
    const view = await mount(detailOf('credential', PUBLIC_MINE), portWith(rowsOf([]), record()));
    const head = view.getByTestId('managed-head');
    expect(head.textContent).toContain('Team key');
    expect(head.textContent).toContain('Anthropic · API key');
    expect(within(head).getByText('Active')).toBeTruthy();
    expect(within(head).getByTestId('managed-owner').textContent).toBe('This space');
    const facts = view.getByTestId('managed-facts');
    expect(within(facts).queryByText('Provider')).toBeNull();
    expect(within(facts).queryByText('Status')).toBeNull();
  });

  it('the key hint is drawn behind dots, and no fact outside the spec is drawn', async () => {
    const view = await mount(detailOf('credential', PUBLIC_MINE), portWith(rowsOf([]), record({ secret: 'sk-ant-SECRET' })));
    expect(view.getByTestId('managed-fact-keyHint').querySelector('dd')?.textContent).toBe('•••• k3Jd');
    expect(view.container.textContent).not.toContain('sk-ant-SECRET');
  });

  it('the lifecycle draws what happened, and says plainly what has not', async () => {
    const view = await mount(detailOf('credential', PUBLIC_MINE), portWith(rowsOf([]), record()));
    const life = view.getByTestId('managed-lifecycle');
    expect(within(life).getByText('Created')).toBeTruthy();
    expect(within(life).getByText('Last verified')).toBeTruthy();
    expect(view.getByTestId('managed-step-lastUsedAt').textContent).toContain('No session has used it yet');
    expect(within(life).queryByText('Revoked')).toBeNull();
  });

  it('a stale credential says it failed its last check rather than "last verified"', async () => {
    const view = await mount(detailOf('credential', PUBLIC_MINE), portWith(rowsOf([]), record({ status: 'stale' })));
    const life = view.getByTestId('managed-lifecycle');
    expect(within(life).getByText('Failed its last check')).toBeTruthy();
    expect(within(life).queryByText('Last verified')).toBeNull();
  });

  it('a revoked credential (not listed) draws its envelope under a note, with a Revoked step and no invented "never used"', async () => {
    const revoked = { kind: 'credential', provider: 'mcp', shape: 'api_key', visibility: 'private', status: 'revoked', ownerAccountId: null };
    const detail = { ...detailOf('credential', PUBLIC_MINE), title: 'yo-yo', state: revoked, content: revoked } as EntityDetail;
    const view = await mount(detail, portWith(rowsOf([]), null));
    expect(view.getByTestId('managed-envelope')).toBeTruthy();
    expect(view.queryByTestId('managed-unreadable')).toBeNull();
    expect(view.getByTestId('managed-head').textContent).toContain('yo-yo');
    expect(view.getByTestId('managed-head').textContent).toContain('Revoked');
    const life = view.getByTestId('managed-lifecycle');
    expect(within(life).getByText('Revoked')).toBeTruthy();
    expect(within(life).queryByText('Last used')).toBeNull();
  });

  it('a failed load says so with a retry, draws no verbs, and retry reloads', async () => {
    const port = portWith(rowsOf([]), record());
    let fail = true;
    port.actions = vi.fn(async () => { if (fail) throw new Error('503'); return rowsOf(['credentials.space.rename']); });
    const view = await mount(detailOf('credential', PUBLIC_MINE), port);
    expect(view.getByTestId('managed-load-error').textContent).toContain('503');
    expect(view.queryByTestId('managed-verbs')).toBeNull();
    fail = false;
    await act(async () => { fireEvent.click(within(view.getByTestId('managed-load-error')).getByText('Retry')); });
    await waitFor(() => expect(view.getByTestId('managed-verb-credentials.space.rename').tagName).toBe('BUTTON'));
    expect(view.queryByTestId('managed-load-error')).toBeNull();
  });

  it('a session in SESSIONS opens that session', async () => {
    const port = portWith(rowsOf(['credentials.space.usage']), record());
    port.run = vi.fn(async () => ({ sessions: [{ workSessionId: 'ws-abcdef123456', source: 'pinned', status: 'running', recordedAt: base.updatedAt }] }));
    const opened: string[] = [];
    const view = render(
      <EntityDetailPanel detail={detailOf('credential', PUBLIC_MINE)} reasons={REASONS} ctx={ctx}
        commands={{ managed: port } as never} onOpenEntity={(id) => opened.push(id)} />,
    );
    const read = await waitFor(() => view.getByTestId('managed-read-credentials.space.usage'));
    expect(within(read).getByText('Running')).toBeTruthy();
    fireEvent.click(within(read).getByText('ws-abcde'));
    expect(opened).toEqual(['ws-abcdef123456']);
  });
});
