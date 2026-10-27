import { useMemo } from 'react';
import type { StoryView } from '../../model';
import { fromStoryView } from '../map-model/adapters';
import { enterStory } from '../enter';
import { MapStudio } from './MapStudio';
export default function StoryMapView({view,open}:{view:StoryView;open?:((id:string)=>void)|undefined}){
  const input=useMemo(()=>fromStoryView(view),[view]);
  return <MapStudio input={input} provenance={`StoryView · ${view.title} · ${view.id} · revision ${view.version}`} onInspect={open} onEnterStory={id=>enterStory(view.id,id)} production/>;
}
