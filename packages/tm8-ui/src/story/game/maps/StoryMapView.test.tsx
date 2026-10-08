// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, cleanup } from '@testing-library/react';
import { afterEach } from 'vitest';
import { STORY_FIXTURE } from '../../fixture';
import StoryMapView from './StoryMapView';
import type { MapStudioProps } from './MapStudio';
const ports=vi.hoisted(()=>({enter:vi.fn()}));
vi.mock('../enter',()=>({enterStory:ports.enter}));
vi.mock('./MapStudio',()=>({MapStudio:(props:MapStudioProps)=><div><span>{props.input.scope?.id}</span><button onClick={()=>props.onInspect?.(props.input.entities.find(n=>n.kind==='task')!.id)}>Inspect real task</button><button onClick={()=>props.onEnterStory?.('child-story-id')}>Enter child</button><span>{props.production?'production':'preview'}</span></div>}));
afterEach(()=>{cleanup();vi.clearAllMocks();});
describe('StoryView atlas navigation',()=>{
  it('preserves story scope and passes original entity identity to inspect',()=>{const open=vi.fn();const screen=render(<StoryMapView view={STORY_FIXTURE} open={open}/>);expect(screen.getByText(STORY_FIXTURE.id)).toBeTruthy();fireEvent.click(screen.getByText('Inspect real task'));expect(open).toHaveBeenCalledWith(expect.any(String));expect(STORY_FIXTURE.page.nodes.some(n=>n.id===open.mock.calls[0]![0])).toBe(true);expect(screen.getByText('production')).toBeTruthy();});
  it('routes child portals through the existing story-entry port',()=>{const screen=render(<StoryMapView view={STORY_FIXTURE}/>);fireEvent.click(screen.getByText('Enter child'));expect(ports.enter).toHaveBeenCalledWith(STORY_FIXTURE.id,'child-story-id');});
});
