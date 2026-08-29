/**
 * Graph fixture — the mock dataset behind the ◉ Graph view prototype
 * (GRAPH-VIEW-PLAN §2, P1). It lives in `fixtures/` because it names kinds and
 * edge types (§15.2), and it deliberately reuses the EXISTING gate entities as
 * nodes: a graph node's C1 click pushes the same id the list panels push, so
 * the Z3 detail panel is real, not a graph-only stub.
 *
 * Edge types are exactly the wild set the contract documents: `working_on`
 * (session→task), `depends_on` (hard/soft + the unresolved-hard blocked path),
 * `tracks` (task→PR/commit), `attached_to`, `relates_to`, `in_project`,
 * `shared_into`. The entities left OUT of the edge set are equally deliberate:
 * they are singleton components and exercise the loose shelf.
 *
 * The TIMELINE is a scripted fixture replay (labeled as such in the toolbar):
 * it demonstrates the §2 arrival grammar — an edge drawing itself in, activity
 * refreshing heat, and a shelf chip promoting onto the canvas when it gains
 * its first edge. It never invents state the detail panels would contradict:
 * steps only add edges and touch `activityAt`.
 */
import type { EdgeView, EntityId, EntitySummary } from '@tm8/contract';
import { forge, scout } from './actors';
import {
  FIXTURE_NOW,
  channelDesign,
  collectionEmpty,
  collectionInbox,
  commitFoundation,
  customRitual,
  docLayoutSpec,
  fileScreenshot,
  memberAda,
  prTransplant,
  profileHouseStyle,
  projectTm8Ui,
  sessionFailed,
  sessionLive,
  sessionStale,
  skillReview,
  spellDeploy,
  taskBlocked,
  taskGuideLines,
  taskTombstone,
  taskUuidTitle,
  teamMemberForge,
  teamMemberScout,
} from './entities';

export const GRAPH_FIXTURE_NOW = FIXTURE_NOW;

function edge(
  id: string,
  type: string,
  source: EntitySummary,
  target: EntitySummary,
  over: Partial<EdgeView> = {},
): EdgeView {
  return {
    id,
    type,
    source,
    target,
    props: {},
    createdBy: forge,
    createdAt: '2026-07-27T18:30:00.000Z',
    updatedAt: '2026-07-27T18:30:00.000Z',
    ...over,
  };
}

/**
 * Canvas cast + shelf cast in one list; the model decides who is a singleton.
 * Tombstone included on purpose — deletion renders as a ghost, never hidden.
 */
export const graphFixtureNodes: EntitySummary[] = [
  channelDesign,
  taskUuidTitle,
  taskGuideLines,
  taskBlocked,
  taskTombstone,
  sessionLive,
  sessionStale,
  sessionFailed,
  docLayoutSpec,
  prTransplant,
  commitFoundation,
  fileScreenshot,
  projectTm8Ui,
  memberAda,
  collectionInbox,
  // Deliberate singletons — the loose shelf:
  teamMemberForge,
  teamMemberScout,
  spellDeploy,
  skillReview,
  collectionEmpty,
  profileHouseStyle,
  customRitual,
];

export const graphFixtureEdges: EdgeView[] = [
  // The live thread: forge's session is genuinely working (live PTY fixture).
  edge('ge-working-live', 'working_on', sessionLive, taskGuideLines),
  // Honesty contrast: scout's session records `running` but has no live PTY —
  // the card renders stale, and this thread must NOT animate.
  edge('ge-working-stale', 'working_on', sessionStale, taskUuidTitle, { createdBy: scout }),
  // A failed session's historical thread: the edge is a fact, the card says failed.
  edge('ge-working-failed', 'working_on', sessionFailed, taskBlocked, { createdBy: scout }),
  // The red path: unresolved HARD dependency.
  edge('ge-dep-hard', 'depends_on', taskBlocked, taskUuidTitle, { hard: true, resolved: false }),
  // A soft, resolved dependency for contrast (renders calm).
  edge('ge-dep-soft', 'depends_on', taskGuideLines, taskUuidTitle, { hard: false, resolved: true }),
  // Tracking: task → PR / commit.
  edge('ge-tracks-pr', 'tracks', taskGuideLines, prTransplant),
  edge('ge-tracks-commit', 'tracks', taskUuidTitle, commitFoundation),
  // Attachments + relations.
  edge('ge-attach-shot', 'attached_to', fileScreenshot, taskGuideLines),
  edge('ge-attach-doc', 'attached_to', docLayoutSpec, channelDesign),
  edge('ge-rel-doc-task', 'relates_to', docLayoutSpec, taskUuidTitle),
  edge('ge-rel-triage', 'relates_to', collectionInbox, channelDesign),
  edge('ge-rel-tombstone', 'relates_to', taskTombstone, channelDesign),
  edge('ge-rel-ada', 'relates_to', memberAda, channelDesign),
  // Project association + a handoff.
  edge('ge-in-project', 'in_project', sessionLive, projectTm8Ui),
  edge('ge-shared-doc', 'shared_into', docLayoutSpec, sessionLive),
];

export type GraphTimelineStep =
  | { atMs: number; kind: 'edge'; edge: EdgeView; label: string }
  | { atMs: number; kind: 'activity'; entityId: EntityId; label: string }
  | { atMs: number; kind: 'note'; label: string };

/**
 * The scripted replay. Labels are the ticker's copy — terse, mono, factual.
 */
export const graphFixtureTimeline: GraphTimelineStep[] = [
  {
    atMs: 3500,
    kind: 'edge',
    edge: edge('ge-t-working-2', 'working_on', sessionLive, taskUuidTitle, {
      createdAt: FIXTURE_NOW,
      updatedAt: FIXTURE_NOW,
    }),
    label: '◔ forge · main → working on → 4f8c2a9e…',
  },
  {
    atMs: 8000,
    kind: 'activity',
    entityId: docLayoutSpec.id,
    label: '▤ Layout spec — edited by forge',
  },
  {
    atMs: 13000,
    kind: 'edge',
    edge: edge('ge-t-ritual', 'relates_to', customRitual, channelDesign, {
      createdAt: FIXTURE_NOW,
      updatedAt: FIXTURE_NOW,
    }),
    label: '◇ standup ritual → relates to → #design',
  },
  {
    atMs: 17000,
    kind: 'activity',
    entityId: taskGuideLines.id,
    label: '◔ forge · main — acceptance criterion checked',
  },
  { atMs: 21000, kind: 'note', label: 'fixture replay complete' },
];
