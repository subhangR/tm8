import { describe, expect, it, vi } from 'vitest';
import type { Seam } from '../../data/seam';
import { createStoryActions } from './useStoryActions';
import { createStorySpawn } from './story-spawn';

function setup() {
  const entity = vi.fn(async (id: string) => ({ id, kind: id.includes('story') ? 'story' : id.includes('doc') ? 'doc' : 'task', spaceId: 'space', version: 1 }));
  const commands = {
    createTask: vi.fn().mockResolvedValue({ entity: { id: 'new-task' } }),
    createEntity: vi.fn().mockResolvedValue({ entity: { id: 'new-doc' } }),
    addToCollection: vi.fn().mockResolvedValue({}),
    spawn: vi.fn().mockResolvedValue({ entity: { id: 'session', title: 'Session' } }),
  };
  const seam = { entity, commands } as unknown as Seam;
  return { entity, commands, seam, actions: createStoryActions(seam, 'story') };
}

describe('Story workspace production ports', () => {
  it('creates markdown under an entity and puts story documents in membership', async () => {
    const { commands, actions } = setup();
    await actions.createDocument!('task', 'Notes');
    expect(commands.createEntity).toHaveBeenLastCalledWith(expect.objectContaining({ kind: 'doc', attachTo: { entityId: 'task', edgeType: 'attached_to' }, title: 'Notes', content: { kind: 'doc', body: '', format: 'markdown' } }));
    expect(commands.createEntity.mock.calls[0]![0]).not.toHaveProperty('parentId');
    expect(commands.addToCollection).not.toHaveBeenCalled();
    await actions.createDocument!('story', 'Story notes');
    expect(commands.createEntity.mock.calls[1]![0]).not.toHaveProperty('parentId');
    expect(commands.addToCollection).toHaveBeenLastCalledWith('story', expect.objectContaining({ entityId: 'new-doc' }));
  });

  it('uses same-kind hierarchy for documents, and atomic attachments for tasks on documents', async () => {
    const { commands, actions } = setup();
    await actions.createDocument!('doc', 'Subdocument');
    expect(commands.createEntity).toHaveBeenLastCalledWith(expect.objectContaining({ parentId: 'doc' }));
    await actions.createTask!('doc', 'Review document');
    expect(commands.createTask).toHaveBeenLastCalledWith(expect.objectContaining({ attachTo: { entityId: 'doc', edgeType: 'attached_to' } }));
    expect(commands.createTask.mock.calls[0]![0]).not.toHaveProperty('parentId');
  });

  it('creates task children and uses membership on a child story', async () => {
    const { commands, actions } = setup();
    await actions.createTask!('task', 'Child');
    expect(commands.createTask).toHaveBeenLastCalledWith(expect.objectContaining({ parentId: 'task', title: 'Child' }));
    await actions.createTask!('child-story', 'Next work');
    expect(commands.createTask.mock.calls[1]![0]).not.toHaveProperty('parentId');
    expect(commands.addToCollection).toHaveBeenLastCalledWith('child-story', expect.objectContaining({ entityId: 'new-task' }));
  });

  it('retries failed root membership without making a second entity', async () => {
    const { commands, actions } = setup();
    commands.addToCollection.mockRejectedValueOnce(new Error('Permission denied'));
    await expect(actions.createDocument!('story', 'Notes')).rejects.toThrow('Created new-doc');
    await expect(actions.createDocument!('story', 'Notes')).resolves.toBe('new-doc');
    expect(commands.createEntity).toHaveBeenCalledTimes(1);
    expect(commands.addToCollection).toHaveBeenCalledTimes(2);
  });

  it.each(['story', 'doc', 'drawing', 'task', 'custom-kind'])('launches on the exact %s subject through execution.spawn', async subject => {
    const { commands, seam } = setup();
    const spawn = createStorySpawn(seam, { storyId: 'story', spaceId: async () => 'space', view: async () => null });
    await spawn({ intent: 'spawn', onId: subject, asTeammateId: 'runner', text: 'Review this entity', tellIds: [] });
    expect(commands.spawn).toHaveBeenCalledWith(expect.objectContaining({ taskIds: [subject], teamMemberId: 'runner', promptExtra: 'Review this entity' }));
  });
});
