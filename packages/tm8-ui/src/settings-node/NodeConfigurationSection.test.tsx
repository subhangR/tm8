// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ConfigKnobView, SpaceConfigsView } from '@tm8/contract';
import { NODE_SETTINGS_PRECEDENCE, NodeConfigurationSection } from './NodeConfigurationSection';

afterEach(cleanup);

const knob = (over: Partial<ConfigKnobView>): ConfigKnobView => ({
  name: 'TM8_PORT',
  group: 'Network & access',
  summary: 'Port the server listens on.',
  value: { kind: 'value', text: '4610' },
  source: 'default',
  default: '4610',
  definedAt: 'packages/server/src/http/config.ts:1',
  change: 'env',
  ...over,
});

function view(knobs: ConfigKnobView[]): SpaceConfigsView {
  return {
    spaceId: 'space' as SpaceConfigsView['spaceId'],
    node: { visible: true, knobs },
    cli: [],
    code: [],
    teammates: [],
    profiles: [],
  };
}

const sessionCap = knob({
  name: 'TM8_SESSION_CAP',
  group: 'Lane launch',
  summary: 'Concurrent agent sessions.',
  value: { kind: 'value', text: '64' },
  default: '64',
  setting: {
    stored: null,
    pinnedByEnv: false,
    applies: 'restart',
    restartPending: false,
    input: { kind: 'integer', min: 1, unlimited: true },
  },
});

describe('NodeConfigurationSection', () => {
  it('states the precedence, groups read-only knobs, and edits a curated setting', async () => {
    const load = vi
      .fn()
      .mockResolvedValueOnce(view([sessionCap, knob({})]))
      .mockResolvedValue(
        view([
          { ...sessionCap, setting: { ...sessionCap.setting!, stored: '32', restartPending: true } },
          knob({}),
        ]),
      );
    const save = vi.fn(async (name: string, value: string | null) => ({
      name,
      stored: value,
      pinnedByEnv: false,
      restartPending: true,
    }));
    render(<NodeConfigurationSection load={load} save={save} />);
    await screen.findByText(NODE_SETTINGS_PRECEDENCE, { exact: false });
    const editable = screen.getByRole('region', { name: 'Editable settings' });
    expect(within(editable).queryByText('TM8_PORT')).toBeNull();
    expect(within(screen.getByRole('region', { name: 'Read-only settings' })).getByText('TM8_PORT')).toBeTruthy();

    fireEvent.change(screen.getByLabelText('New value'), { target: { value: '32' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(save).toHaveBeenCalledWith('TM8_SESSION_CAP', '32'));
    // Reloaded: the stored value is shown, with the restart it still needs.
    await screen.findByText('Restart the server to apply: TM8_SESSION_CAP.');
    expect(screen.getByText('Restart needed: the server is not yet running the stored value.')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Clear stored value' }));
    await waitFor(() => expect(save).toHaveBeenLastCalledWith('TM8_SESSION_CAP', null));
  });

  it('says when the environment outranks the stored value', async () => {
    const pinned = {
      ...sessionCap,
      source: 'env' as const,
      setting: { ...sessionCap.setting!, stored: '8', pinnedByEnv: true },
    };
    render(<NodeConfigurationSection load={async () => view([pinned])} save={vi.fn()} />);
    await screen.findByText(/Set in the server environment, which outranks a stored setting/);
    expect(screen.getByText(/Source: server environment/)).toBeTruthy();
  });

  it('warns on the lockout settings and shows the server refusal', async () => {
    const mode = knob({
      name: 'TM8_NODE_MODE',
      value: { kind: 'unset' },
      default: 'single',
      setting: {
        stored: null,
        pinnedByEnv: false,
        applies: 'restart',
        restartPending: false,
        input: { kind: 'enum', options: ['single', 'multi'] },
      },
    });
    const save = vi.fn(async () => {
      throw new Error('Sign in with your account password before changing it.');
    });
    render(<NodeConfigurationSection load={async () => view([mode])} save={save} />);
    await screen.findByText(/multi turns off loopback sign-in at the next restart/);
    fireEvent.change(screen.getByLabelText('New value'), { target: { value: 'multi' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    expect((await screen.findByRole('alert')).textContent).toBe(
      'Not saved: Sign in with your account password before changing it.',
    );
  });

  it('lists the server\'s setup warnings', async () => {
    const open = vi.fn();
    const withWarnings: SpaceConfigsView = {
      ...view([]),
      node: {
        visible: true,
        knobs: [],
        warnings: [
          { id: 'single_mode_published', text: 'This node runs in single mode.', settings: ['TM8_NODE_MODE'] },
          { id: 'node_credential_fallback', text: 'Members run on the node login.', settings: ['GH_TOKEN'] },
        ],
      },
    };
    render(<NodeConfigurationSection load={async () => withWarnings} onOpenCredentials={open} />);
    const region = await screen.findByRole('region', { name: 'Setup warnings' });
    expect(within(region).getByText('This node runs in single mode.')).toBeTruthy();
    fireEvent.click(within(region).getByRole('button', { name: 'Open Node credentials' }));
    expect(open).toHaveBeenCalled();
  });

  it('points provider keys at Node credentials instead of editing them', async () => {
    const open = vi.fn();
    const key = knob({
      name: 'ANTHROPIC_API_KEY',
      group: 'Keys',
      value: { kind: 'secret', present: true },
      default: null,
      managedIn: 'node_credentials',
    });
    render(<NodeConfigurationSection load={async () => view([key])} save={vi.fn()} onOpenCredentials={open} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Open Node credentials' }));
    expect(open).toHaveBeenCalled();
    expect(screen.queryByLabelText('New value')).toBeNull();
  });
});
