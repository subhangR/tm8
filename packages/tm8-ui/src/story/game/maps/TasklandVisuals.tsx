import { Line } from '@react-three/drei';
import type { MapGroup, MapModel, MapPlace } from '../map-model';
import { readStudioPalette } from '../studioPalette';
import { MapAsset } from './MapAsset';

const colors = readStudioPalette();
// Optional projection fields let the helper also render older saved models.
type VisualPlace = MapPlace & { estimateMissing?: boolean; rubbleExpiresAt?: number | null;
  mailbox: (NonNullable<MapPlace['mailbox']> & { basis?: 'unread' | 'messages' }) | null };
type VisualModel = MapModel & { shippingYard?: { position: { x: number; z: number }; waitingIds: readonly string[] } };
const YARDS: Record<string, { title: string; color: string }> = {
  to_do: { title: 'Planning yard', color: colors.todo },
  in_progress: { title: 'Construction yard', color: colors.working },
  review: { title: 'Review yard', color: colors.review },
  blocked: { title: 'Paused yard', color: colors.blocked },
  cancelled: { title: 'Rubble yard', color: colors.propMuted },
  shipped: { title: 'Shipped foundations', color: colors.done },
};

export interface TasklandLabel {
  id: string; title: string; detail: string; x: number; y: number; z: number;
  priority: number; cue: 'surveyor' | 'mailbox' | 'yard' | 'shipping'; entityId?: string;
}
/** The model owns progress, status districts and subtree counts. This only names the cues. */
export function tasklandPlotDetail(place: VisualPlace): string {
  if (place.role === 'shipped-marker') return 'Shipped · children still building';
  if (place.constructionStage === 'rubble') return place.rubbleExpiresAt == null
    ? 'Cancelled · cancellation time unknown'
    : `Cancelled · rubble clears ${new Date(place.rubbleExpiresAt).toISOString().replace('T', ' ').replace('.000Z', ' UTC')}`;
  const progress = place.progress === null ? 'Progress unknown' : `${Math.floor(place.progress * 100 + 1e-9)}%`;
  const stage = place.constructionStage.replaceAll('-', ' ');
  const status = place.status?.replaceAll('_', ' ');
  return `${place.parentId ? 'Nested yard · ' : ''}${progress} · ${stage}${status ? ` · ${status}` : ''}`;
}
export function shippingYardCount(model: VisualModel): number {
  if (model.type !== 'town') return 0;
  if (model.shippingYard) return model.shippingYard.waitingIds.length;
  // Compatibility for snapshots saved before the placement projection existed.
  const waiting = new Set(model.groups.filter(g => g.key === 'shipping-yard').flatMap(g => g.placeIds));
  return model.places.filter(p => waiting.has(p.id) && p.role !== 'shipped-marker' && p.constructionStage !== 'rubble' && p.status !== 'cancelled').length;
}
export function shippingYardPosition(model: VisualModel): { x: number; z: number } {
  return model.shippingYard?.position ?? { x: -8, z: -8 };
}
export function tasklandLabels(model: MapModel): TasklandLabel[] {
  if (model.type === 'town') {
    const gate = shippingYardPosition(model), count = shippingYardCount(model);
    return [{ id: `${model.id}:shipping`, title: 'Shipping Yard', detail: `${count} waiting for placement`,
      x: gate.x, y: 1.7, z: gate.z + 4.5, priority: -3, cue: 'shipping' }];
  }
  if (model.type !== 'taskland') return [];
  const labels: TasklandLabel[] = [];
  for (const p of model.places as VisualPlace[]) {
    if (p.kind !== 'task') continue;
    const size = Math.max(1.6, p.radius * 1.9);
    if ((p.estimateMissing ?? p.badges.includes('estimate-missing')) && p.constructionStage !== 'rubble' && p.role !== 'shipped-marker') {
      labels.push({ id: `${p.id}:surveyor`, title: 'Surveyor tent', detail: 'Estimate needed · size defaults to 1',
        x: p.x - size * .48, y: .8, z: p.z + size * .62, priority: 3 + p.depth, cue: 'surveyor', entityId: p.entityId });
    }
    if (!p.parentId) {
      const count = p.mailbox === null ? '?' : `${p.mailbox.approx ? '≈' : ''}${p.mailbox.count}`;
      labels.push({ id: `${p.id}:mailbox`, title: 'ROOT mailbox', detail: `${count} subtree ${p.mailbox?.basis === 'unread' ? 'unread' : 'messages'} · ${p.attention} attention`,
        x: p.x + size * .67, y: 1.1, z: p.z + size * .42, priority: -2, cue: 'mailbox', entityId: p.entityId });
    }
  }
  for (const group of model.groups) {
    const location = group.key === 'cancelled' || group.key === 'shipped' ? 'Plot markers' : group.depth ? 'Mini yard' : 'District';
    labels.push({ id: `${group.id}:yard`, title: `${location} · ${yardStyle(group).title}`,
      detail: `${group.placeIds.length} ${group.depth ? 'nested plots' : 'root compounds'}`,
      x: group.bounds.minX, y: .5, z: group.bounds.maxZ + 1.5, priority: 8 + group.depth, cue: 'yard' });
  }
  return labels;
}
function yardStyle(group: MapGroup) { return YARDS[group.key] ?? YARDS.to_do!; }
function Beam({ position, size, color }: { position: [number, number, number]; size: [number, number, number]; color: string }) {
  return <mesh position={position} castShadow receiveShadow><boxGeometry args={size}/><meshStandardMaterial color={color} roughness={.85}/></mesh>;
}
/** A triangular canvas shelter with ridge, open entrance, stakes and survey board. */
function SurveyorTent() {
  return <group name="taskland-surveyor-tent">
    <mesh position={[0, .35, 0]} rotation={[0, 0, Math.PI / 2]} castShadow><cylinderGeometry args={[.52, .52, .85, 3]}/><meshStandardMaterial color="#ead7aa" roughness={.95}/></mesh>
    <Beam position={[.44,.27,0]} size={[.025,.54,.025]} color={colors.flagPost}/>
    <Beam position={[-.44,.27,0]} size={[.025,.54,.025]} color={colors.flagPost}/>
    <Beam position={[.47,.22,0]} size={[.025,.32,.28]} color={colors.contactShadow}/>
    <Beam position={[0,.62,0]} size={[.94,.035,.035]} color={colors.flagPost}/>
    {[-1,1].flatMap(x => [-1,1].map(z => <Beam key={`${x}:${z}`} position={[x*.5,.07,z*.4]} size={[.045,.14,.045]} color={colors.flagPost}/>))}
    <Beam position={[.15,.18,.64]} size={[.38,.3,.035]} color={colors.propSurface}/>
    <Beam position={[.15,.025,.64]} size={[.05,.32,.05]} color={colors.flagPost}/>
  </group>;
}
function RootMailbox({ attention }: { attention: number }) {
  return <group name="taskland-root-mailbox">
    <Beam position={[0,.44,0]} size={[.11,.88,.11]} color={colors.flagPost}/>
    <Beam position={[0,.93,0]} size={[.57,.38,.36]} color={colors.propInk}/>
    <Beam position={[0,.94,.19]} size={[.44,.035,.025]} color={colors.propSurface}/>
    <Beam position={[.34,attention ? 1.2 : .88,0]} size={[.055,attention ? .43 : .13,.06]} color={attention ? colors.flag : colors.done}/>
    {attention > 0 && <Beam position={[.44,1.37,0]} size={[.26,.15,.06]} color={colors.flag}/>}
  </group>;
}
export function TasklandPlotCues({ place, size }: { place: VisualPlace; size: number }) {
  if (place.kind !== 'task') return null;
  return <group name={`taskland-cues:${place.entityId}`}>
    {(place.estimateMissing ?? place.badges.includes('estimate-missing')) && place.constructionStage !== 'rubble' && place.role !== 'shipped-marker' &&
      <group position={[-size*.48,0,size*.28]}><SurveyorTent/></group>}
    {!place.parentId && <group position={[size*.67,0,size*.15]}><RootMailbox attention={place.attention}/></group>}
    {place.progress !== null && place.constructionStage !== 'rubble' && place.role !== 'shipped-marker' && <group position={[0,.15,size*.65]}>
      <Beam position={[0,0,0]} size={[size*.9,.09,.11]} color={colors.propMuted}/>
      {place.progress > 0 && <Beam position={[-size*.45*(1-place.progress),.01,0]} size={[size*.9*place.progress,.11,.13]} color={colors.done}/>}
    </group>}
  </group>;
}
export function TasklandDistrictCues({ model }: { model: MapModel }) {
  if (model.type !== 'taskland') return null;
  return <group name="taskland-status-yards">{model.groups.map(g => {
    const b = g.bounds, color = yardStyle(g).color;
    return <group key={g.id} name={`taskland-yard:${g.id}`}>
      <Line points={[[b.minX,.095,b.minZ],[b.maxX,.095,b.minZ],[b.maxX,.095,b.maxZ],[b.minX,.095,b.maxZ],[b.minX,.095,b.minZ]]}
        color={color} lineWidth={g.depth ? 1.5 : 3} dashed={g.depth > 0} dashSize={.5} gapSize={.25}/>
      {[b.minX,b.maxX].flatMap(x => [b.minZ,b.maxZ].map(z => <Beam key={`${x}:${z}`} position={[x,.2,z]} size={[.13,g.depth ? .25 : .4,.13]} color={color}/>))}
    </group>;
  })}</group>;
}
export function ShippingYardGate({ model }: { model: MapModel }) {
  if (model.type !== 'town') return null;
  const gate = shippingYardPosition(model);
  return <group position={[gate.x,.15,gate.z]} name="shipping-yard-gate">
    <MapAsset assetKey="shipping-yard" size={6}/>
    <Beam position={[0,1.65,2.6]} size={[3.2,.58,.15]} color={colors.propInk}/>
    <Beam position={[-1.55,.83,2.6]} size={[.12,1.66,.12]} color={colors.flagPost}/>
    <Beam position={[1.55,.83,2.6]} size={[.12,1.66,.12]} color={colors.flagPost}/>
  </group>;
}
