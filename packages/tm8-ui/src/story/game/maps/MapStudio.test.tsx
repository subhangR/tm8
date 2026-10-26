// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render } from '@testing-library/react';
import { smallFixture, type MapModel } from '../map-model';
import { MapStudio } from './MapStudio';
import type { MapSceneProps } from './MapScene';
const captured=vi.hoisted(()=>({model:null as MapModel|null}));
vi.mock('./MapAsset',()=>({useAssetReport:()=>({used:[],fallbacks:[],instances:0,loading:false,errors:[]})}));
vi.mock('./MapScene',()=>({MAP_META:{hub:{title:'Hub'},taskland:{title:'Taskland'},office:{title:'Office'},library:{title:'Library'},factory:{title:'Factory'},town:{title:'Town'}},MapScene:(props:MapSceneProps)=>{captured.model=props.model;return <div/>;}}));
afterEach(()=>{cleanup();window.history.replaceState({},'','/');});
describe('studio keeps shared layout history',()=>{
  it('keeps unrelated task coordinates when status updates arrive and when returning to a map',()=>{
    window.history.replaceState({},'','/?map=taskland');
    const input=smallFixture();const screen=render(<MapStudio input={input}/>);
    const before=captured.model!.places.find(p=>p.id==='task-foundation')!;
    const changed={...input,entities:input.entities.map(n=>n.id==='task-review'?{...n,status:'blocked'}:n)};
    screen.rerender(<MapStudio input={changed}/>);
    const after=captured.model!.places.find(p=>p.id===before.id)!;
    expect({x:after.x,z:after.z}).toEqual({x:before.x,z:before.z});
    const positions=captured.model!.places.map(p=>[p.id,p.x,p.z]);
    fireEvent.click(screen.getByTestId('map-library'));fireEvent.click(screen.getByTestId('map-taskland'));
    expect(captured.model!.places.map(p=>[p.id,p.x,p.z])).toEqual(positions);
  });
});
