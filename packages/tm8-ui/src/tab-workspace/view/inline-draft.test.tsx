// @vitest-environment jsdom
import { cleanup,fireEvent,render,screen,waitFor } from '@testing-library/react';
import { afterEach,expect,it,vi } from 'vitest';
import { useWorkspaceState,WorkspaceContext,type WorkspaceContextValue } from './context';
import { createWorkspaceStore } from '../runtime/store';
import { createWorkspaceRuntime } from '../runtime/dispatch';
import { activeTab } from '../runtime/selectors';
import { InlineDraftTitle } from './InlineDraftTitle';
import { DraftHost } from '../adapters/draft';
import { useTabFacts } from './TabStrip';
import type { DraftTabRecord } from '../runtime/types';
import { createStore } from 'zustand/vanilla';
import { summary } from '../../data/project/test-support';

afterEach(cleanup);
function DraftLabel({tab}:{tab:DraftTabRecord}) {
  const facts=useTabFacts(tab);
  return <span data-testid="draft-tab-title">{facts.title}</span>;
}
function Both() {
  const tab=useWorkspaceState(activeTab);
  return tab?.type==='draft'?<><DraftLabel tab={tab}/><InlineDraftTitle tab={tab}/><DraftHost tab={tab}/></>:<p>Saved entity tab</p>;
}
function setup(parentId?:string) {
  const key=crypto.randomUUID();const store=createWorkspaceStore(key,key);const runtime=createWorkspaceRuntime(key,key,store);
  runtime.dispatch({command:'workspace.drafts.open',args:{kind:'task'},source:'click'});
  const tab=activeTab(store.getState())!;
  if(tab.type!=='draft')throw new Error('Expected draft');
  if(parentId)runtime.drafts.set(tab.draftId,{parentId});
  const createEntity=vi.fn(async(input)=>({entity:summary('saved',{title:input.title}),patches:[]}));
  const value={runtime,store,dispatch:runtime.dispatch,viewerId:key,spaceId:key,gate:{data:{domain:{store:createStore(()=>({entities:{},details:{}}))},seam:{commands:{createEntity}},reconcileCommand:vi.fn()}}} as unknown as WorkspaceContextValue;
  render(<WorkspaceContext.Provider value={value}><Both/></WorkspaceContext.Provider>);
  return {runtime,createEntity};
}
it('opens the detail draft immediately, synchronizes titles both ways and saves the child once',async()=>{
  const {runtime,createEntity}=setup('parent');
  expect(screen.getByTestId('tws-draft-host')).toBeTruthy();expect(createEntity).not.toHaveBeenCalled();
  const inline=screen.getByRole('textbox',{name:'New entity title'});
  const detail=screen.getByTestId('tws-draft-title');
  fireEvent.change(inline,{target:{value:'Inline name'}});expect((detail as HTMLInputElement).value).toBe('Inline name');
  expect(screen.getByTestId('draft-tab-title').textContent).toBe('Inline name');
  fireEvent.change(detail,{target:{value:'Detail name'}});expect((inline as HTMLInputElement).value).toBe('Detail name');
  expect(screen.getByTestId('draft-tab-title').textContent).toBe('Detail name');
  fireEvent.submit(inline.closest('form')!);
  await waitFor(()=>expect(activeTab(runtime.store.getState())?.type).toBe('entity'));
  expect(createEntity).toHaveBeenCalledTimes(1);expect(createEntity.mock.calls[0]![0]).toMatchObject({title:'Detail name',parentId:'parent'});
});
it('blank title creates nothing and Escape discards the provisional row and tab',()=>{
  const {runtime,createEntity}=setup();const inline=screen.getByRole('textbox',{name:'New entity title'});
  fireEvent.submit(inline.closest('form')!);expect(createEntity).not.toHaveBeenCalled();
  fireEvent.change(inline,{target:{value:'Discard'}});fireEvent.keyDown(inline,{key:'Escape'});
  expect(activeTab(runtime.store.getState())).toBeNull();expect(createEntity).not.toHaveBeenCalled();
});
