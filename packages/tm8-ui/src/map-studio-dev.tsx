import { createRoot } from 'react-dom/client';
import { MapStudio } from './story/game/maps';
import { smallFixture, nestedFixture, denseFixture, fromProjection, type MapInput } from './story/game/map-model';
const scopedDemo=(input:MapInput):MapInput=>({entities:input.entities,edges:input.edges});
createRoot(document.getElementById('root')!).render(<MapStudio input={scopedDemo(smallFixture())} nestedInput={scopedDemo(nestedFixture())} denseInput={scopedDemo(denseFixture(120))} provenance="Synthetic deterministic fixtures · no live business state · dense preset: 120 entities" onImport={async file=>{
  const raw=JSON.parse(await file.text());
  const input=fromProjection(raw);
  if(!input.scope)throw new Error('Snapshot must declare its scope: {scope:{kind:"space"|"story",id}} or {id,kind:"story",page}.');
  return {input,provenance:`Local snapshot · ${file.name} · ${input.scope.kind} ${input.scope.id} · ${raw.provenance?.capturedAt??raw.provenance?.source??'imported from JSON'} · read only`};
}}/>);
