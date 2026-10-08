// @vitest-environment jsdom
import { cleanup, fireEvent, render, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { EntityKindCreateInputSchema } from '@tm8/contract';
import { draftToCreateInput } from '../settings-governance/governance-model';
import { createFixtureSeam } from '../data';
import { settingsPortFromSeam } from './port';
import { MenuEditor } from './MenuEditor';
import { governancePortFromSeam } from '../settings-governance/port';
import { CustomKindsScreen } from '../settings-governance/CustomKindsScreen';
import { createRealSeam } from '../data/real/seam-real';
import { fakeFetch, fakeSocketPool } from '../data/real/test-support';

afterEach(cleanup);
async function fixture() {
  const seam = createFixtureSeam();
  const space = (await seam.spaces())[0];
  return { seam, space, port: settingsPortFromSeam(seam, space.id), governance: governancePortFromSeam(seam, space.id) };
}

it('persists menu changes and rejects stale revisions', async () => {
  const { port, seam, space } = await fixture();
  const events: unknown[] = [];
  seam.onEvent((event) => events.push(event));
  await seam.openSpace(space.id);
  const base = await port.loadMenu();
  const payload = { schemaVersion: base.config.schemaVersion, groups: base.config.groups };
  const saved = await port.saveMenu!(payload, 0);
  expect(saved.config.revision).toBe(1);
  expect(await port.loadMenu()).toEqual(saved);
  expect((await seam.spaceSettings(space.id)).menu).toEqual(saved.config);
  await waitFor(() => expect(events).toContainEqual(expect.objectContaining({ type: 'menu.updated', menu: saved.config })));
  await expect(port.saveMenu!(payload, 0)).rejects.toThrow('Menu changed');
  expect((await port.saveMenu!(payload, 1)).config.revision).toBe(2);
});

it('menu editor submits the missing-row revision and displays failures', async () => {
  const { port } = await fixture();
  const menu = await port.loadMenu();
  const save = vi.fn(async () => { throw new Error('Menu revision conflict'); });
  const draw = render(<MenuEditor menu={menu} onSave={save} />);
  const group = menu.config.groups[0];
  fireEvent.click(draw.getByRole('button', { name: `rename ${group.label}` }));
  const input = draw.getByRole('textbox', { name: `rename ${group.label}` });
  fireEvent.change(input, { target: { value: 'Renamed group' } });
  fireEvent.keyDown(input, { key: 'Enter' });
  fireEvent.click(draw.getByRole('button', { name: 'Save menu' }));
  expect((await draw.findByRole('alert')).textContent).toBe('Menu revision conflict');
  expect(save).toHaveBeenCalledWith(expect.objectContaining({ groups: expect.arrayContaining([expect.objectContaining({ label: 'Renamed group' })]) }), 0);
});

it('creates a custom kind from the form and persists only wire schema fields', async () => {
  const { governance } = await fixture();
  const onCreate = vi.fn(governance.createKind!);
  const draw = render(<CustomKindsScreen spaceLabel="Space" kinds={{ phase: 'ready', value: [] }} onCreate={onCreate} />);
  fireEvent.change(draw.getByPlaceholderText('incident'), { target: { value: 'Incident' } });
  fireEvent.change(draw.getByPlaceholderText('Incidents'), { target: { value: 'Incidents' } });
  fireEvent.click(draw.getByRole('radio', { name: 'Glyph ◮' }));
  fireEvent.click(draw.getByRole('button', { name: 'Create kind' }));
  await draw.findByText('Custom kind created.');
  const result = (await governance.entityKinds()).find((row) => row.kind === 'c:incident');
  expect(result).toBeTruthy();
  expect(draw.getByTestId('existing-kind-row').textContent).toContain('c:incident');
  await expect(governance.createKind!({ kind: 'c:incident', fieldSchema: [] })).rejects.toThrow('Kind already exists');
});

it('shows custom-kind server errors without losing the draft', async () => {
  const onCreate = vi.fn(async () => { throw new Error('Space admin required'); });
  const draw = render(<CustomKindsScreen spaceLabel="Space" kinds={{ phase: 'ready', value: [] }} onCreate={onCreate} />);
  fireEvent.change(draw.getByPlaceholderText('incident'), { target: { value: 'Incident' } });
  fireEvent.change(draw.getByPlaceholderText('Incidents'), { target: { value: 'Incidents' } });
  fireEvent.click(draw.getByRole('radio', { name: 'Glyph ◮' }));
  fireEvent.click(draw.getByRole('button', { name: 'Create kind' }));
  expect((await draw.findByRole('alert')).textContent).toBe('Space admin required');
  expect((draw.getByPlaceholderText('incident') as HTMLInputElement).value).toBe('Incident');
});

it.each([-1, 1.5, 10081])('rejects invalid auto-close value %s before writing any profile fields', async (minutes) => {
  const { port, space } = await fixture();
  await expect(port.updateSpace!({ name: 'Must not land', sessionAutoCloseMinutes: minutes })).rejects.toThrow('integer between 0 and 10080');
  expect((await port.loadSpace())?.name).toBe(space.name);
});

it('real seam sends menu and kind writes to their bound endpoints and retains server errors', async () => {
  const transport = fakeFetch(() => ({ status: 403, error: { code: 'forbidden', message: 'Admin required', requestId: 'test', retryable: false } }));
  const seam = createRealSeam({ baseUrl: '', wsUrl: 'ws://fake.invalid/v2/ws', fetch: transport.fetch, webSocketFactory: fakeSocketPool().factory });
  const menu = { expectedRevision: 7, payload: { schemaVersion: 1 as const, groups: [] }, clientMutationId: 'menu-test' };
  await expect(seam.commands.updateMenu!('bound-space', menu)).rejects.toThrow('Admin required');
  expect(transport.last()).toMatchObject({ method: 'PUT', url: '/v2/spaces/bound-space/menu', body: menu });
  const kind = { kind: 'c:incident' as const, fieldSchema: [], clientMutationId: 'kind-test' };
  await expect(seam.commands.createEntityKind!('bound-space', kind)).rejects.toThrow('Admin required');
  expect(transport.last()).toMatchObject({ method: 'POST', url: '/v2/spaces/bound-space/entity-kinds', body: kind });
  seam.dispose();
});

it('custom-kind writes disable editing until the server answers', async () => {
  let fail!: (error: Error) => void;
  const onCreate = vi.fn(() => new Promise<never>((_resolve, reject) => { fail = reject; }));
  const draw = render(<CustomKindsScreen spaceLabel="Space" kinds={{ phase: 'ready', value: [] }} onCreate={onCreate} />);
  fireEvent.change(draw.getByPlaceholderText('incident'), { target: { value: 'Incident' } });
  fireEvent.change(draw.getByPlaceholderText('Incidents'), { target: { value: 'Incidents' } });
  fireEvent.click(draw.getByRole('radio', { name: 'Glyph ◮' }));
  fireEvent.click(draw.getByRole('button', { name: 'Create kind' }));
  expect(draw.getByRole('button', { name: 'Creating…' }).closest('fieldset')?.disabled).toBe(true);
  fail(new Error('Try again'));
  await draw.findByRole('alert');
  expect(draw.getByRole('button', { name: 'Create kind' }).closest('fieldset')?.disabled).toBe(false);
});

it('custom-kind field drafts serialize to the strict backend contract', () => {
  const input = draftToCreateInput({ name: 'incident', plural: 'Incidents', glyph: '◮', fields: [
    { id: 'local-field', name: 'severity', type: 'enum', required: true, values: ['low', 'high'] },
    { id: 'local-title', name: 'summary', type: 'text', required: false, values: [] },
  ] }, 'create-kind-test');
  expect(EntityKindCreateInputSchema.safeParse(input).success).toBe(true);
  expect(input?.fieldSchema[0]).not.toHaveProperty('id');
  expect(input?.fieldSchema[1]).not.toHaveProperty('values');
});
