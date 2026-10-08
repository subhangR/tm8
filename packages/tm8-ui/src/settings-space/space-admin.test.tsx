// @vitest-environment jsdom
import { cleanup, fireEvent, render, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createFixtureSeam } from '../data';
import { settingsPortFromSeam } from './port';
import { SpaceAdminPage, SPACE_ADMIN_SECTIONS } from './SpaceAdminPage';
import { SettingsShell } from './SettingsShell';
import { ProfileSection } from './ProfileSection';

afterEach(cleanup);
async function fixture(role = 'owner', membershipSpace?: string) {
  const seam = createFixtureSeam();
  const space = (await seam.spaces())[0];
  const port = settingsPortFromSeam(seam, space.id);
  const identity = await port.loadIdentity();
  port.loadIdentity = vi.fn(async () => ({ ...identity, memberships: [{ spaceId: membershipSpace ?? space.id, memberId: 'viewer', role }] }));
  return { seam, space, port };
}

describe('space administration boundary', () => {
  it.each(['owner', 'admin'])('allows %s and limits sections to space settings', async (role) => {
    const { port } = await fixture(role);
    const draw = render(<SpaceAdminPage port={port} initialSection="node-credentials" sections={{ 'node-credentials': <p>Node content</p>, profile: <p>Space profile content</p>, account: <p>Personal content</p> }} />);
    await draw.findByText('Space profile content');
    expect(draw.queryByText('Node content')).toBeNull();
    expect(draw.queryByText('Personal content')).toBeNull();
    expect(draw.queryByRole('button', { name: 'Your profile' })).toBeNull();
    expect(draw.queryByRole('button', { name: 'Node credentials' })).toBeNull();
    expect(draw.getAllByRole('button').length).toBe(SPACE_ADMIN_SECTIONS.length);
  });
  it.each([['member', undefined], ['owner', 'another-space'], ['unknown', undefined]])('refuses role %s in %s before child reads or mounting', async (role, scope) => {
    const { port } = await fixture(role, scope);
    const read = vi.spyOn(port, 'loadMembers');
    const child = vi.fn(() => <p>Privileged content</p>);
    const Child = child;
    const draw = render(<SpaceAdminPage port={port} sections={{ profile: <Child /> }} />);
    await draw.findByRole('alert');
    expect(child).not.toHaveBeenCalled();
    expect(read).not.toHaveBeenCalled();
  });
  it('fails closed on identity errors and port switches', async () => {
    const a = await fixture();
    const b = await fixture();
    b.port.loadIdentity = vi.fn(async () => { throw new Error('Identity unavailable'); });
    const draw = render(<SpaceAdminPage port={a.port} sections={{ profile: <p>Privileged content</p> }} />);
    await draw.findByText('Privileged content');
    draw.rerender(<SpaceAdminPage port={b.port} sections={{ profile: <p>Privileged content</p> }} />);
    expect(draw.queryByText('Privileged content')).toBeNull();
    expect((await draw.findByRole('alert')).textContent).toContain('Identity unavailable');
  });
  it('preserves unfiltered legacy settings and filters deep links', async () => {
    const { port } = await fixture();
    const draw = render(<SettingsShell port={port} initialSection="account" sections={{ account: <p>Personal content</p> }} />);
    expect(draw.getByText('Personal content')).toBeTruthy();
    expect(draw.getByRole('button', { name: 'Node credentials' })).toBeTruthy();
    draw.rerender(<SettingsShell port={port} sectionIds={['profile']} initialSection="account" sections={{ account: <p>Personal content</p>, profile: <p>Filtered content</p> }} />);
    expect(draw.queryByText('Personal content')).toBeNull();
    expect(draw.getByText('Filtered content')).toBeTruthy();
    await waitFor(() => expect(port.loadIdentity).toHaveBeenCalled());
  });
});

describe('space profile writes', () => {
  it('submits all four fields with pending state and shows server failures', async () => {
    const { space } = await fixture();
    let reject!: (error: Error) => void;
    const save = vi.fn(() => new Promise<void>((_resolve, no) => { reject = no; }));
    const draw = render(<ProfileSection space={space} heading="Profile" onSave={save} />);
    fireEvent.change(draw.getByLabelText('Name'), { target: { value: 'New name' } });
    fireEvent.change(draw.getByLabelText('Description'), { target: { value: 'Description' } });
    fireEvent.change(draw.getByLabelText('GitHub repository'), { target: { value: 'team/repo' } });
    fireEvent.change(draw.getByLabelText('Session auto-close minutes'), { target: { value: '0' } });
    fireEvent.click(draw.getByRole('button', { name: 'Save space details' }));
    expect(save).toHaveBeenCalledWith({ name: 'New name', description: 'Description', githubRepo: 'team/repo', sessionAutoCloseMinutes: 0 });
    expect(draw.getByRole('button', { name: 'Saving…' }).closest('fieldset')?.disabled).toBe(true);
    reject(new Error('Space admin required'));
    expect((await draw.findByRole('alert')).textContent).toBe('Space admin required');
    expect(draw.getByRole('button', { name: 'Save space details' }).closest('fieldset')?.disabled).toBe(false);
  });
  it('does not offer writes without an authorized callback', async () => {
    const { space } = await fixture();
    const draw = render(<ProfileSection space={space} heading="Profile" />);
    expect(draw.queryByLabelText('Name')).toBeNull();
  });
  it('adapter binds profile writes to its space and preserves server results', async () => {
    const { port, seam, space } = await fixture();
    const patch = { name: 'New space', description: '', githubRepo: null, sessionAutoCloseMinutes: 0 };
    const write = vi.spyOn(seam.commands, 'updateSpace');
    const result = await port.updateSpace!(patch);
    expect(write).toHaveBeenCalledWith(space.id, expect.objectContaining(patch));
    expect(result.sessionAutoCloseMinutes).toBe(0);
    expect(result.name).toBe('New space');
    expect((await port.loadSpace())?.name).toBe('New space');
  });
});

  it('rechecks membership on focus, invalidates changed identity, and supports retry', async () => {
    const { port } = await fixture();
    const identity = await port.loadIdentity();
    const draw = render(<SpaceAdminPage port={port} identity={identity} sections={{ profile: <p>Protected</p> }} />);
    await draw.findByText('Protected');
    port.loadIdentity = vi.fn(async () => ({ ...identity, memberships: [] }));
    fireEvent.focus(window);
    expect(draw.queryByText('Protected')).toBeNull();
    await draw.findByRole('alert');
    port.loadIdentity = vi.fn(async () => identity);
    fireEvent.click(draw.getByRole('button', { name: 'Retry access check' }));
    await draw.findByText('Protected');
    draw.rerender(<SpaceAdminPage port={port} identity={{ ...identity }} sections={{ profile: <p>Protected</p> }} />);
    expect(draw.queryByText('Protected')).toBeNull();
    await draw.findByText('Protected');
  });
