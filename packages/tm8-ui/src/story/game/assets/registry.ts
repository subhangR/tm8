/**
 * THE ASSET REGISTRY — which visual type every map entity is, as DATA.
 *
 * The owner's rule: each map entity must read as a DIFFERENT THING, by
 * silhouette and structure, not by colour or label. This file is the single
 * place entity semantics become visual types. Builders (`prototypes.ts`) never
 * see a kind; the scene never sees a kind. A new entity kind gets an explicit
 * row here or falls to the `unknown-cairn` — never to the task workshop.
 *
 * TYPE IS NOT STATE. `assetTypeOf` picks the thing; `assetStateOf` picks its
 * condition. A task stays a gabled workshop whether it is half-built, working,
 * waiting, blocked or done — state adds scaffolding, smoke, shutters, boards or
 * a finial, never a different building. The single deliberate type switch is
 * the session: a RUNNING session is a robot (owner decision: exactly one robot
 * per running session) and an ENDED one is a stele — a non-live marker, so a
 * finished run can never be mistaken for a working robot.
 *
 * Kind strings come from story/model.ts constants; no kind literal appears in
 * this lane's rendering code (§15.2).
 */
import type { StatusCategory } from '@tm8/contract';
import {
  STORY_KIND, TASK_KIND, ATTENTION_KIND, SESSION_KIND, TEAMMATE_KIND, DOCUMENT_KIND, ARTIFACT_KIND, DRAWING_KIND,
  FILE_KIND, MEMORY_KIND, PULL_REQUEST_KIND, COMMIT_KIND, WORKTREE_KIND, MESSAGE_KIND, UNMAPPED_ASSET_KINDS,
} from '../../model';

/** Things that stand on the map (or inside a container) for one entity. */
export type EntityAssetType =
  | 'story-keep' | 'story-gate'
  | 'task-workshop' | 'attention-belfry'
  | 'session-robot' | 'session-stele'
  | 'teammate-camp'
  | 'doc-lectern' | 'artifact-vitrine' | 'drawing-easel' | 'file-crate' | 'memory-crystal'
  | 'pr-tollgate' | 'commit-milestone' | 'worktree-branch'
  | 'message-letter'
  | 'unknown-cairn';

/** Presentation containers: they group entities, they are not entity kinds. */
export type ContainerAssetType =
  | 'story-library' | 'story-code-factory'
  | 'task-library' | 'task-mailbox'
  | 'task-code-shed' | 'mailbox-categories';

export type AssetType = EntityAssetType | ContainerAssetType;

/**
 * Condition, shared by every type. Each type declares which it draws.
 * planned = not started (a task is half-built); working; waiting (on a person
 * or review); blocked; done; cancelled (closed without completing).
 */
export type AssetState = 'planned' | 'working' | 'waiting' | 'blocked' | 'done' | 'cancelled';
export const ASSET_STATES: readonly AssetState[] = ['planned', 'working', 'waiting', 'blocked', 'done', 'cancelled'];

export type AssetFamily = 'story' | 'work' | 'session' | 'people' | 'knowledge' | 'code' | 'mail' | 'container' | 'fallback';

/** Where an asset lives. `map`: its own plot. `contained`: drawn inside/at a container. */
export type AssetPlacement = 'map' | 'contained' | 'map-or-contained' | 'attached';

/** Owner decision, this lane's chosen default, a labelled proposal, or still open. */
export type AssetDecision = 'owner' | 'default' | 'proposal';

/** Named attachment points every builder reports, in the asset's local frame (door faces +Z). */
export type SocketName = 'door' | 'sign' | 'badge' | 'left' | 'right' | 'back' | 'robot' | 'top';

export interface AssetSpec {
  type: AssetType;
  label: string;
  family: AssetFamily;
  /** What makes it readable with colour switched off. */
  silhouette: string;
  /** The recognisable props, in kit vocabulary. */
  parts: readonly string[];
  /** The states this type draws; any other state renders as the nearest one (`stateFor`). */
  states: readonly AssetState[];
  /** What each state adds or removes — the type's core never changes. */
  stateCues: Partial<Readonly<Record<AssetState, string>>>;
  placement: AssetPlacement;
  /** For contained assets: the container that usually holds them. */
  container: ContainerAssetType | null;
  interaction: string;
  decision: AssetDecision;
  /** Unresolved product questions this asset leaves open, if any. */
  open?: string;
}

/* ------------------------------------------------------------------------- */
/* KIND → TYPE. The only place a kind string meets an asset.                  */
/* ------------------------------------------------------------------------- */
export const ASSET_OF_KIND: Readonly<Record<string, EntityAssetType>> = {
  [STORY_KIND]: 'story-keep',
  [TASK_KIND]: 'task-workshop',
  [ATTENTION_KIND]: 'attention-belfry',
  [SESSION_KIND]: 'session-robot',
  [TEAMMATE_KIND]: 'teammate-camp',
  [DOCUMENT_KIND]: 'doc-lectern',
  [ARTIFACT_KIND]: 'artifact-vitrine',
  [DRAWING_KIND]: 'drawing-easel',
  [FILE_KIND]: 'file-crate',
  [MEMORY_KIND]: 'memory-crystal',
  [PULL_REQUEST_KIND]: 'pr-tollgate',
  [COMMIT_KIND]: 'commit-milestone',
  [WORKTREE_KIND]: 'worktree-branch',
  [MESSAGE_KIND]: 'message-letter',
};

/** Kinds that exist but have no settled map form yet: they draw the cairn and are listed as open. */
export const UNRESOLVED_KINDS = UNMAPPED_ASSET_KINDS;

/** The one non-live substitute: an ended session must never draw a robot. */
const ENDED_FORM: Partial<Readonly<Record<EntityAssetType, EntityAssetType>>> = { 'session-robot': 'session-stele' };
/** A story seen from another story (child or linked) is its gate, not its keep. */
const LINKED_FORM: Partial<Readonly<Record<EntityAssetType, EntityAssetType>>> = { 'story-keep': 'story-gate' };

/**
 * The place's role in the world, when the layout knows it. Containers are
 * roles, not kinds: a Library place has no entity kind of its own.
 */
export type AssetRole = 'hub' | 'portal' | 'node' | 'library' | 'codeFactory' | 'taskLibrary' | 'mailbox';
const ROLE_ASSET: Readonly<Partial<Record<AssetRole, AssetType>>> = {
  library: 'story-library', codeFactory: 'story-code-factory', taskLibrary: 'task-library', mailbox: 'task-mailbox',
};

export interface AssetSubject {
  kind: string;
  /** A running session (the source's `live`). Ignored by every other type. */
  live: boolean;
  /** `portal`: a story seen from another story's map draws its gate; container roles draw their container. */
  role?: AssetRole;
}

export function assetTypeOf(n: AssetSubject): AssetType {
  const container = n.role ? ROLE_ASSET[n.role] : undefined;
  if (container) return container;
  const base = ASSET_OF_KIND[n.kind] ?? 'unknown-cairn';
  if (!n.live && ENDED_FORM[base]) return ENDED_FORM[base]!;
  if (n.role === 'portal' && LINKED_FORM[base]) return LINKED_FORM[base]!;
  return base;
}

export interface StateSubject {
  statusCategory: StatusCategory | null;
  blocked?: boolean;
  /** Supplied by the adapter (pending attention, review, a question) — never guessed from a status name. */
  waiting?: boolean;
  /** False when nobody is running it: an open task with no worker stays half-built (`planned`). */
  hasWorker?: boolean;
}

/** Categories, never status names: a renamed workflow must not change a building. */
export function assetStateOf(n: StateSubject): AssetState {
  if (n.statusCategory === 'cancelled') return 'cancelled';
  if (n.statusCategory === 'done') return 'done';
  if (n.blocked) return 'blocked';
  if (n.waiting) return 'waiting';
  if (n.statusCategory === 'in_progress' && n.hasWorker !== false) return 'working';
  return 'planned';
}

/** The nearest drawable state for a type (e.g. a live robot is never `done`). */
export function stateFor(type: AssetType, state: AssetState): AssetState {
  const states = ASSET_SPECS[type].states;
  if (states.includes(state)) return state;
  const fallback: Readonly<Record<AssetState, readonly AssetState[]>> = {
    planned: ['working', 'waiting', 'done'],
    working: ['planned', 'waiting', 'done'],
    waiting: ['working', 'planned', 'done'],
    blocked: ['waiting', 'cancelled', 'working', 'done'],
    done: ['working', 'waiting'],
    cancelled: ['done', 'blocked', 'planned'],
  };
  return fallback[state].find((s) => states.includes(s)) ?? states[0]!;
}

const WORK: readonly AssetState[] = ['planned', 'working', 'waiting', 'blocked', 'done', 'cancelled'];

/* ------------------------------------------------------------------------- */
/* THE DESIGN RECORD — one row per type. Rendered by the catalog, tested.    */
/* ------------------------------------------------------------------------- */
export const ASSET_SPECS: Readonly<Record<AssetType, AssetSpec>> = {
  'story-keep': {
    type: 'story-keep', label: 'Story Keep', family: 'story',
    silhouette: 'Tall round crenellated keep with a side turret and a long swallowtail pennant — the only castle on the map.',
    parts: ['round stepped plinth', 'cylinder keep', 'crenellation ring', 'round spire turret', 'arched gate', 'swallowtail pennant', 'story scroll banner'],
    states: ['planned', 'working', 'blocked', 'done'],
    stateCues: { planned: 'scaffold ring on the battlements, pennant furled', working: 'pennant flying, gate lit', blocked: 'boarded gate, block-tone pennant', done: 'gold crown finial on the spire' },
    placement: 'map', container: null, interaction: 'Walk to the gate; E enters the story page. Hub of its own map.', decision: 'default',
  },
  'story-gate': {
    type: 'story-gate', label: 'Story Gate', family: 'story',
    silhouette: 'Two crenellated towers joined by a big arch with a swirling gem — the castle motif as a doorway.',
    parts: ['twin square towers', 'crenellations', 'great arch', 'portal gem', 'pennants'],
    states: ['planned', 'working', 'blocked', 'done'],
    stateCues: { planned: 'gem dim, no pennants', working: 'gem bobbing, pennants up', blocked: 'bar across the arch', done: 'gold keystone' },
    placement: 'map', container: null, interaction: 'Walk through to travel to the child or linked story.', decision: 'default',
  },
  'task-workshop': {
    type: 'task-workshop', label: 'Task Workshop', family: 'work',
    silhouette: 'Half-timbered house, steep front gable, chimney, hanging checkbox sign — the map\'s only gabled house.',
    parts: ['square stone footing', 'half-timbered walls', 'front gable roof (prism)', 'chimney', 'door with arch', 'two windows', 'round gable window', 'hanging checkbox sign'],
    states: WORK,
    stateCues: {
      planned: 'half-built: timber frame and rafters, low walls, scaffold, material crate — still a gabled house outline',
      working: 'chimney smoke, glowing windows, ladder at the wall',
      waiting: 'closed shutters, hourglass post at the door',
      blocked: 'boards crossed over the door, barrier trestle, block-tone roof',
      done: 'gold ridge finial and rooftop flag, flower boxes, no smoke',
      cancelled: 'faded walls, one plank across the door, sign unhung',
    },
    placement: 'map', container: null, interaction: 'Door apron receives roads; E opens the task. Sockets: left (Library), right (Mailbox), robot (running session), back (steles).', decision: 'owner',
  },
  'attention-belfry': {
    type: 'attention-belfry', label: 'Attention Belfry', family: 'work',
    silhouette: 'Open four-post bell tower with a pyramid cap and a hanging bell.',
    parts: ['four posts', 'pyramid cap', 'bell', 'rope'],
    states: ['waiting', 'done', 'cancelled'],
    stateCues: { waiting: 'bell swinging, wait-tone', done: 'bell still, muted', cancelled: 'bell removed' },
    placement: 'map-or-contained', container: null, interaction: 'Ring = needs someone; opens the attention item.', decision: 'default',
    open: 'Whether attention items stand alone or hang on their task as an attached bell.',
  },
  'session-robot': {
    type: 'session-robot', label: 'Session Robot', family: 'session',
    silhouette: 'Small upright robot: round head with visor, antenna, boxy body on treads, glowing ground ring.',
    parts: ['treads', 'box body', 'chest screen', 'round head', 'visor', 'antenna beacon', 'arms', 'live ground ring'],
    states: ['planned', 'working', 'waiting', 'blocked'],
    stateCues: { planned: 'idle: arms down, info-tone visor', working: 'run-tone visor, wrench arm raised', waiting: 'attention: thought bubbles, head tilted, wait-tone visor', blocked: 'block-tone visor and warning gem overhead' },
    placement: 'map', container: null, interaction: 'Exactly one per RUNNING session; stands at its task\'s robot socket; E opens the session / duel.', decision: 'owner',
  },
  'session-stele': {
    type: 'session-stele', label: 'Session Stele', family: 'session',
    silhouette: 'Slim stone obelisk with a pyramid cap and an inset outcome gem — narrow, still, unmistakably not a robot.',
    parts: ['stepped round pad', 'tapered shaft', 'pyramid cap', 'outcome gem', 'terminal plaque (>_)'],
    states: ['done', 'blocked', 'cancelled'],
    stateCues: { done: 'upright, gold gem', blocked: 'failed: cap knocked to the ground, shaft tilted, block-tone gem', cancelled: 'stopped: grey shroud over the cap, grey gem' },
    placement: 'map-or-contained', container: null, interaction: 'Stands behind its task (back socket), up to 3 per cluster with a count badge; E opens the session transcript.', decision: 'default',
    open: 'Whether ended sessions of a story with no task cluster at the keep or are hidden after a retention window.',
  },
  'teammate-camp': {
    type: 'teammate-camp', label: 'Teammate Camp', family: 'people',
    silhouette: 'A-frame tent with a campfire and a pennant — a person-place, no robot.',
    parts: ['A-frame tent (prism)', 'campfire stones', 'flame gem', 'pennant'],
    states: ['planned', 'working'],
    stateCues: { planned: 'fire unlit', working: 'fire lit (teammate has a running session elsewhere)' },
    placement: 'map', container: null, interaction: 'Opens the teammate. Assigned teammates without a running session get NO robot (owner decision).', decision: 'owner',
  },
  'doc-lectern': {
    type: 'doc-lectern', label: 'Document Lectern', family: 'knowledge',
    silhouette: 'A giant open book on a slanted stand — a wide V.',
    parts: ['round podium', 'slanted stand', 'open book (two pages + spine)', 'bookmark ribbon'],
    states: ['planned', 'done'],
    stateCues: { planned: 'draft: blank pages, quill', done: 'written pages, gold ribbon' },
    placement: 'map-or-contained', container: 'task-library', interaction: 'Opens the document. Contained form: a book on the Library rack.', decision: 'default',
    open: 'When a document stands on the map vs. only on its Library rack (layout policy, not this lane).',
  },
  'artifact-vitrine': {
    type: 'artifact-vitrine', label: 'Artifact Vitrine', family: 'knowledge',
    silhouette: 'Glass display case on a column with a floating exhibit gem.',
    parts: ['column pedestal', 'glass case', 'gold frame cap', 'exhibit gem'],
    states: ['planned', 'done'],
    stateCues: { planned: 'empty case', done: 'exhibit gem floating' },
    placement: 'map-or-contained', container: 'task-library', interaction: 'Opens the published artifact.', decision: 'default',
  },
  'drawing-easel': {
    type: 'drawing-easel', label: 'Drawing Easel', family: 'knowledge',
    silhouette: 'Tripod easel holding a tilted canvas, with a palette board.',
    parts: ['three-leg easel', 'canvas', 'paint strokes', 'palette disc'],
    states: ['planned', 'done'],
    stateCues: { planned: 'blank canvas', done: 'canvas with strokes' },
    placement: 'map-or-contained', container: 'task-library', interaction: 'Opens the drawing.', decision: 'default',
  },
  'file-crate': {
    type: 'file-crate', label: 'File Crates', family: 'knowledge',
    silhouette: 'Off-stacked wooden crates with a giant paperclip on top.',
    parts: ['two stacked crates', 'small crate', 'slats', 'paperclip ring'],
    states: ['done'],
    stateCues: {},
    placement: 'map-or-contained', container: 'task-library', interaction: 'Opens the file.', decision: 'default',
  },
  'memory-crystal': {
    type: 'memory-crystal', label: 'Memory Crystals', family: 'knowledge',
    silhouette: 'Cluster of tall gems in a gold ring — no walls at all.',
    parts: ['gold base ring', 'five crystals'],
    states: ['done'],
    stateCues: {},
    placement: 'map', container: null, interaction: 'Opens the memory.', decision: 'default',
  },
  'pr-tollgate': {
    type: 'pr-tollgate', label: 'Pull-request Tollgate', family: 'code',
    silhouette: 'Small booth beside a long striped barrier arm, with a merge-Y signpost.',
    parts: ['booth with flat roof', 'status lamp', 'striped barrier arm', 'merge Y sign', 'road stub'],
    states: ['working', 'waiting', 'blocked', 'done', 'cancelled'],
    stateCues: { working: 'arm down, info lamp (open)', waiting: 'arm down, wait lamp (in review)', blocked: 'arm down, block lamp, X on the arm (changes requested / failing)', done: 'arm raised, gold (merged)', cancelled: 'arm lying on the ground (closed)' },
    placement: 'map-or-contained', container: 'story-code-factory', interaction: 'Opens the PR.', decision: 'default',
  },
  'commit-milestone': {
    type: 'commit-milestone', label: 'Commit Milestone', family: 'code',
    silhouette: 'Low rounded milestone stone with a ring node on a rail line.',
    parts: ['milestone stone', 'node ring', 'rail line'],
    states: ['done'],
    stateCues: {},
    placement: 'contained', container: 'story-code-factory', interaction: 'Opens the commit. Repeated along the factory conveyor.', decision: 'default',
  },
  'worktree-branch': {
    type: 'worktree-branch', label: 'Worktree Branch Post', family: 'code',
    silhouette: 'Pole that forks into two branch arms with pipe ends.',
    parts: ['pole', 'branch arms', 'pipe caps'],
    states: ['working', 'done'],
    stateCues: { working: 'caps lit', done: 'caps dark' },
    placement: 'contained', container: 'story-code-factory', interaction: 'Opens the worktree.', decision: 'default',
  },
  'message-letter': {
    type: 'message-letter', label: 'Message Letter', family: 'mail',
    silhouette: 'Envelope with a seal.',
    parts: ['envelope', 'flap', 'wax seal'],
    states: ['done'],
    stateCues: {},
    placement: 'contained', container: 'task-mailbox', interaction: 'Messages never stand on the map; they fill the mailbox count.', decision: 'default',
  },
  'unknown-cairn': {
    type: 'unknown-cairn', label: 'Unknown-kind Cairn', family: 'fallback',
    silhouette: 'Stacked stone cairn under a floating question gem.',
    parts: ['three stacked stones', 'floating gem'],
    states: ['done'],
    stateCues: {},
    placement: 'map', container: null, interaction: 'Any kind without a row in ASSET_OF_KIND. Visible on purpose: a missing mapping should look missing.', decision: 'default',
  },
  'story-library': {
    type: 'story-library', label: 'Story Library', family: 'container',
    silhouette: 'Wide colonnaded hall with a pediment and a dome, an open book over the door.',
    parts: ['wide stepped base', 'hall', 'four columns', 'pediment (prism)', 'drum and dome', 'arched side windows', 'open-book emblem', 'count badge'],
    states: ['done'],
    stateCues: {},
    placement: 'map', container: null, interaction: 'One per story. Enter to browse every doc/artifact/drawing/file in the story; badge counts them.', decision: 'owner',
  },
  'story-code-factory': {
    type: 'story-code-factory', label: 'Story Code Factory', family: 'container',
    silhouette: 'Sawtooth-roofed works with a tall banded smokestack, a front gear and an outgoing conveyor.',
    parts: ['concrete slab', 'works hall', 'sawtooth roof (3 prisms)', 'banded smokestack', 'gear', 'roll-up door', 'conveyor with commit cubes', 'branch pipes'],
    states: ['planned', 'working', 'done'],
    stateCues: { planned: 'cold stack', working: 'stack smoking, commit cubes on the belt', done: 'cold stack, cubes delivered' },
    placement: 'map', container: null, interaction: 'One per story. Holds PRs, commits and worktrees; enter to list them.', decision: 'owner',
  },
  'task-library': {
    type: 'task-library', label: 'Task Library annex', family: 'container',
    silhouette: 'Lean-to bookcase annex with book spines and a shed roof.',
    parts: ['annex footing', 'bookcase', 'shelves', 'book spines (count-scaled)', 'shed roof', 'count badge'],
    states: ['done'],
    stateCues: {},
    placement: 'attached', container: null, interaction: 'Attaches to the task\'s LEFT socket; badge = knowledge items on the task; opens the task\'s list of them.', decision: 'owner',
  },
  'task-mailbox': {
    type: 'task-mailbox', label: 'Task Mailbox', family: 'container',
    silhouette: 'Round-topped mailbox on a post with a side flag.',
    parts: ['post', 'mailbox body', 'round top', 'flag', 'letters in the slot', 'count badge'],
    states: ['planned', 'done'],
    stateCues: { planned: 'empty: flag down', done: 'has messages: flag up, letters sticking out' },
    placement: 'attached', container: null, interaction: 'Stands at the task\'s RIGHT socket; badge = messages; opens the task thread.', decision: 'owner',
  },
  'task-code-shed': {
    type: 'task-code-shed', label: 'Task Code Shed (PROPOSAL)', family: 'container',
    silhouette: 'Tiny shed with a gear sign, a branch post and commit stones.',
    parts: ['shed', 'shed roof', 'gear sign', 'branch post', 'commit stones'],
    states: ['planned', 'working', 'done'],
    stateCues: { working: 'branch caps lit', done: 'PR arm raised beside it' },
    placement: 'attached', container: null, interaction: 'Exploratory: would attach at the task BACK socket for task-scoped PRs/commits.', decision: 'proposal',
    open: 'Owner has not decided whether tasks get their own code shed or code only lives in the story factory.',
  },
  'mailbox-categories': {
    type: 'mailbox-categories', label: 'Mailbox bank (PROPOSAL)', family: 'container',
    silhouette: 'Three mailboxes on a crossbar, each with its own flag.',
    parts: ['crossbar', 'three mailboxes', 'three flags', 'count badges'],
    states: ['done'],
    stateCues: {},
    placement: 'attached', container: null, interaction: 'Exploratory: questions / results / blockers as separate boxes.', decision: 'proposal',
    open: 'Message categories are not a product rule yet.',
  },
};

export const ENTITY_ASSET_TYPES = Object.keys(ASSET_SPECS).filter((t) => ASSET_SPECS[t as AssetType].family !== 'container') as EntityAssetType[];
export const CONTAINER_ASSET_TYPES = Object.keys(ASSET_SPECS).filter((t) => ASSET_SPECS[t as AssetType].family === 'container') as ContainerAssetType[];
