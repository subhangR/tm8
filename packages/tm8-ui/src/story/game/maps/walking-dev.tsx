/** Synthetic renderer verification only. No production loaders or local-save substitute. */
import { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { StoryGame } from '../StoryGame';
import { STORY_FIXTURE } from '../../fixture';
import { buildMapModel, smallFixture, type MapType } from '../map-model';
import { walkingEntrance } from '../map-model/walking-world';
import { WalkingMapView, type MapCameraState } from './WalkingMapView';
import '../../../styles/tokens.css'
import '../../../styles/app.css';
import './studio.css';
const query = new URLSearchParams(location.search);
const type = (query.get('map') ?? 'hub') as MapType;
const model = buildMapModel(smallFixture(), { type, scope: smallFixture().scope! });
const resume = query.has('resume') ? JSON.parse(query.get('resume')!) as { start: { x: number; z: number }; camera: MapCameraState } : null;
function Verification() {
  const [mounted, setMounted] = useState(true);
  const [pose, setPose] = useState(resume?.start ?? walkingEntrance(model));
  const [camera, setCamera] = useState<MapCameraState | undefined>(resume?.camera);
  const [action, setAction] = useState('');
  const [saves, setSaves] = useState(0);
  return <div className="cv2-root" style={{ height: '100%', zoom: 1 }}>
    <output id="verification-state" style={{ position: 'absolute', left: 8, top: 8, zIndex: 30, fontSize: 10 }} data-position={JSON.stringify(pose)} data-camera={JSON.stringify(camera)} data-action={action} data-saves={saves}>Synthetic renderer verification · {type}</output>
    <button id="verification-unmount" style={{ position: 'absolute', right: 8, bottom: 8, zIndex: 30 }} onClick={() => setMounted(false)}>Unmount renderer</button>
    {mounted && (query.get('view') === 'story' ? <StoryGame view={STORY_FIXTURE} mode="game" onMode={() => {}} showModeSwitch={false}/> : <WalkingMapView model={model} start={pose} camera={camera} onPosition={(x, z) => { setPose({ x, z }); setSaves(count => count + 1); }} onCamera={setCamera} onInspect={id => setAction(`inspect:${id}`)} onEnterPortal={portal => setAction(`portal:${portal.id}`)} onBack={() => setAction('back')}/>)}
  </div>;
}
createRoot(document.getElementById('root')!).render(<Verification/>);
