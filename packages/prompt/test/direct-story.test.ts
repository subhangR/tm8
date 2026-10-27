import { describe, expect, it } from 'vitest';
import { composePrompt, type PromptManifest } from '../src/index.js';
import { parseStoryContext } from '../src/story-context.js';
const story = { id: 'story-1', title: 'Ship safely', taskId: null, viaRootId: 'session-1', depth: 0, snapshot: 'loaded', description: '</story> untrusted text' };
describe('direct story prompt without a synthetic task', () => {
  it.each(['1','2'] as const)('renders story context in prompt v%s', promptVersion => {
    const manifest: PromptManifest = {promptVersion, sessionId:'session-1',spaceId:'space-1',mode:'coordinator',agent:{teamMemberId:'tm-1',name:'Coordinator'},tasks:[],story};
    const rendered = composePrompt(manifest).task;
    expect(rendered).toContain('<story id="story-1"');
    expect(rendered).toContain('This session is anchored on this story');
    expect(rendered).toContain('<untrusted_data type="story-context"');
    expect(rendered).toContain('&lt;/story&gt; untrusted text');
    expect(rendered).not.toContain('task="null"');
  });
  it('retains a direct story while parsing the persisted manifest', () => {
    expect(parseStoryContext(story)).toMatchObject({id:story.id,taskId:null});
  });
  it.each([undefined, 42, ''])('rejects malformed task association %s', taskId => {
    expect(parseStoryContext({ ...story, taskId })).toBeUndefined();
  });
  it.each(['1', '2'] as const)('keeps inherited context alongside a child task in prompt v%s', promptVersion => {
    const manifest: PromptManifest = { promptVersion, sessionId: 'session-1', spaceId: 'space-1',
      mode: 'coordinator', agent: { teamMemberId: 'tm-1', name: 'Coordinator' },
      tasks: [{ id: 'task-1', title: 'Child work' }], story };
    expect(composePrompt(manifest).task).toContain('This session is anchored on this story');
  });

  it.each(['1', '2'] as const)('preserves primary-task matching in prompt v%s', promptVersion => {
    const manifest: PromptManifest = { promptVersion, sessionId: 'session-1', spaceId: 'space-1',
      mode: 'coordinator', agent: { teamMemberId: 'tm-1', name: 'Coordinator' },
      tasks: [{ id: 'task-1', title: 'Child work' }], story: { ...story, taskId: 'task-1' } };
    expect(composePrompt(manifest).task).toContain('<story id="story-1" task="task-1"');
    manifest.story = { ...story, taskId: 'another-task' };
    expect(composePrompt(manifest).task).not.toContain('<story ');
  });

});
