// @vitest-environment jsdom
import { fireEvent, render, screen, waitFor, cleanup } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import type { EntityDetail, SkillPreviewResult } from '@tm8/contract';
import { detail, summary } from '../data/project/test-support';
import { SkillBody } from './SkillBody';
import { SkillEquipment } from './SkillEquipment';
import { SkillPreview } from './SkillPreview';
import { SkillCreateControl } from './SkillCreateControl';
import type { SkillPort } from './port';
afterEach(cleanup);
const skill = { ...detail('skill'), title: 'Demo', state: { kind: 'skill', provider: 'agents', level: 'project', frontmatter: { custom: 'keep me' }, equipped: false, missing: false, changedOnDisk: true, sourcePath: '/repo/.agents/skills/demo/SKILL.md', description: 'Description' }, content: { kind: 'skill', content: '# Live body\n[other](tm8://skill/other)' } } as EntityDetail;
const result: SkillPreviewResult = { native: [], indexed: [], skipped: [{ entityId: 'gone', name: 'Gone', reason: 'missing' }], scannedAt: null, rows: [] };
function port(): SkillPort { return { roots: vi.fn(async () => ({ projects: [{ id: 'project', workingDir: '/repo' }], homes: ['/home/me'] })), list: vi.fn(async () => [summary('person', { title: 'Ada' })]), equip: vi.fn(async () => ({})), create: vi.fn(async () => ({})), edit: vi.fn(async () => ({})), preview: vi.fn(async () => result) }; }
it('renders actual content.content, metadata, changed state and navigable skill links', () => {
 const open = vi.fn(); render(<SkillBody detail={skill} onOpenEntity={open} />);
 expect(screen.getByRole('heading', { name: 'Live body' })).toBeTruthy(); expect(screen.getByText('keep me')).toBeTruthy(); expect(screen.getByText(/Changed on disk/)).toBeTruthy();
 fireEvent.click(screen.getByRole('button', { name: 'other' })); expect(open).toHaveBeenCalledWith('other');
});
it('searches equipment and invokes teammate equip then unequip', async () => {
 const api = port(); const view = render(<SkillEquipment detail={skill} port={api} />);
 fireEvent.click(screen.getByRole('button', { name: 'Equip' }));
 await screen.findByRole('button', { name: 'Equip Ada' });
 fireEvent.change(screen.getByLabelText('Search skills or teammates'), { target: { value: 'Ada' } });
 fireEvent.click(screen.getByRole('button', { name: 'Equip Ada' })); await waitFor(() => expect(api.equip).toHaveBeenCalledWith('skill', 'person', true));
 const equipped = { ...skill, connections: { ...skill.connections, incoming: [{ type: 'equips', direction: 'incoming', label: 'equips', edges: [{ id: 'e', source: summary('person', { title: 'Ada' }), target: skill }] }] } } as EntityDetail;
 view.rerender(<SkillEquipment detail={equipped} port={api} />); fireEvent.click(screen.getByRole('button', { name: 'Unequip' })); await waitFor(() => expect(api.equip).toHaveBeenCalledWith('skill', 'person', false));
});
it('loads the authorized preview and renders native/indexed/skipped groups', async () => {
 const load = vi.fn(async () => result); render(<SkillPreview load={load} teamMemberId="person" projectId="project" agentTool="codex" />);
 await screen.findByText('Gone'); expect(load).toHaveBeenCalledWith({ teamMemberId: 'person', projectId: 'project', agentTool: 'codex' });
 for (const name of ['NATIVE', 'INDEXED', 'SKIPPED']) expect(screen.getByRole('heading', { name })).toBeTruthy();
});
it('defaults filesystem create to agents/project and submits body', async () => {
 const api = port(); render(<SkillCreateControl spaceId="space" port={api} />); fireEvent.click(screen.getByText('New skill'));
 await screen.findByLabelText('Name'); fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'demo' } }); fireEvent.change(screen.getByLabelText('Body'), { target: { value: 'Instructions' } }); fireEvent.click(screen.getByText('Create SKILL.md'));
 await waitFor(() => expect(api.create).toHaveBeenCalledWith('space', { provider: 'agents', level: 'project', root: 'project', name: 'demo', description: '', body: 'Instructions' }));
});
