// @vitest-environment jsdom
import { fireEvent, render, screen, waitFor, cleanup } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import type { EntityDetail, EntitySummary, SkillPreviewResult } from '@tm8/contract';
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
 expect(screen.getByText('No teammate is equipped with this skill yet.')).toBeTruthy();
 fireEvent.click(screen.getByRole('button', { name: '+ Equip teammate' }));
 await screen.findByRole('button', { name: 'Ada' });
 fireEvent.change(screen.getByLabelText('Search teammates'), { target: { value: 'Ada' } });
 fireEvent.click(screen.getByRole('button', { name: 'Ada' })); await waitFor(() => expect(api.equip).toHaveBeenCalledWith('skill', 'person', true));
 expect(screen.getByRole('button', { name: 'Ada' }).getAttribute('aria-pressed')).toBe('true');
 const equipped = { ...skill, connections: { ...skill.connections, incoming: [{ type: 'equips', direction: 'incoming', label: 'equips', edges: [{ id: 'e', source: summary('person', { title: 'Ada' }), target: skill }] }] } } as EntityDetail;
 view.rerender(<SkillEquipment detail={equipped} port={api} />); expect(screen.getByText('USED BY · 1')).toBeTruthy();
 fireEvent.click(screen.getByRole('button', { name: 'Unequip Ada' })); await waitFor(() => expect(api.equip).toHaveBeenCalledWith('skill', 'person', false));
});
it('teammate picker groups skills by friendly scope and searches across separators, description and scope', async () => {
 const teammate = { ...detail('team_member'), title: 'Worker', state: { kind: 'team_member' } } as unknown as EntityDetail;
 const skillRow = (id: string, title: string, description: string, level: string, provider: string) => ({ ...summary(id, { title }), kind: 'skill', state: { kind: 'skill', provider, level, root: { kind: 'project', ref: '/repo' }, description, missing: false, frontmatter: {} } }) as unknown as EntitySummary;
 const api = { ...port(), list: vi.fn(async () => [skillRow('cr', 'code-review', 'Review a diff', 'project', 'claude'), skillRow('dp', 'deploy', 'Ship to prod', 'user', 'agents')]) };
 render(<SkillEquipment detail={teammate} port={api} />);
 fireEvent.click(screen.getByRole('button', { name: '+ Equip skill' }));
 await screen.findByRole('button', { name: 'code-review' });
 expect(screen.getByText('Project · Claude')).toBeTruthy(); expect(screen.getByText('User · Agents')).toBeTruthy();
 const search = screen.getByLabelText('Search skills');
 fireEvent.change(search, { target: { value: 'code review' } });
 expect(screen.getByRole('button', { name: 'code-review' })).toBeTruthy(); expect(screen.queryByRole('button', { name: 'deploy' })).toBeNull();
 fireEvent.change(search, { target: { value: 'prod' } }); expect(screen.getByRole('button', { name: 'deploy' })).toBeTruthy();
 fireEvent.change(search, { target: { value: 'user agents' } }); expect(screen.getByRole('button', { name: 'deploy' })).toBeTruthy(); expect(screen.queryByRole('button', { name: 'code-review' })).toBeNull();
 fireEvent.change(search, { target: { value: 'zzz' } }); expect(screen.getByText(/No skills match/)).toBeTruthy();
 fireEvent.change(search, { target: { value: '' } });
 fireEvent.click(screen.getByRole('button', { name: 'deploy' })); await waitFor(() => expect(api.equip).toHaveBeenCalledWith('dp', 'team_member', true));
});
it('reverts the picker check when the equip call fails', async () => {
 const api = { ...port(), equip: vi.fn(async () => { throw new Error('denied'); }) };
 render(<SkillEquipment detail={skill} port={api} />);
 fireEvent.click(screen.getByRole('button', { name: '+ Equip teammate' }));
 fireEvent.click(await screen.findByRole('button', { name: 'Ada' }));
 await waitFor(() => expect(screen.getAllByRole('alert').some(a => a.textContent?.includes('denied'))).toBe(true));
 expect(screen.getByRole('button', { name: 'Ada' }).getAttribute('aria-pressed')).toBe('false');
});
it('edits in place: Edit swaps the reader for the form, Cancel brings it back', () => {
 render(<SkillBody detail={skill} port={port()} />);
 fireEvent.click(screen.getByRole('button', { name: 'Edit skill' }));
 expect(screen.queryByRole('heading', { name: 'Live body' })).toBeNull(); expect(screen.getByLabelText('Body')).toBeTruthy();
 fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
 expect(screen.getByRole('heading', { name: 'Live body' })).toBeTruthy();
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
