/**
 * COLLECTION — Entity Help, wave 3.
 *
 * Every claim below is read from this build, not from memory:
 *   - membership is a `contains` edge, collection → any kind, `props.position`
 *     orders it (domain/edge-kinds.ts `contains`; db 001 registration);
 *   - add without a position appends after the current maximum, re-adding
 *     re-positions instead of duplicating, a collection cannot contain itself,
 *     nesting is legal (db/migrations/100_collection_membership.sql,
 *     `set_collection_item`);
 *   - remove deletes only the edge and needs only the collection live, so a
 *     membership pointing at an archived entity can still be cleared (same
 *     migration, `remove_collection_item`);
 *   - itemCount counts live members only (server facade/entity-read.ts, the
 *     `contains` predicate), and soft delete leaves edges in place, so a
 *     restored member is counted again;
 *   - every list offers a Collections picker and a collection lens
 *     (domain/registry.ts COLLECTION_MEMBERSHIP / COLLECTIONS_BLOCK).
 */
import type { KindHelpModule } from '../types';
import { Reveal } from '../motion/Reveal';

/* The signature moment: four entities of four kinds landing on one shelf, in
   the order their `contains` edges carry. It reuses the filmstrip classes, so
   under reduced motion the frames are simply there. */
const SHELF: readonly { readonly kind: string; readonly title: string }[] = [
  { kind: 'Task', title: 'Ship the billing retry' },
  { kind: 'Doc', title: 'Retry policy, v2' },
  { kind: 'Memory', title: 'Stripe 429s cluster at :00' },
  { kind: 'Collection', title: 'Incident notes' },
];

function Shelf() {
  return (
    <>
      <p>
        Four kinds, one shelf. Each frame is a <code>contains</code> edge from the collection to the thing, and the
        number on it is the edge&apos;s position.
      </p>
      <section className="eh-film">
        <span className="eh-eyebrow">Q3 billing launch</span>
        <ol className="eh-film__strip" aria-label="An example collection holding four entities in order">
          {SHELF.map((item, index) => (
            <li key={item.title} className="eh-film__frame" style={{ ['--eh-delay' as string]: `${index * 160}ms` }}>
              <span className="eh-film__number" aria-hidden>
                {String(index + 1).padStart(2, '0')}
              </span>
              <span className="eh-film__name">{item.kind}</span>
              <span className="eh-film__note">{item.title}</span>
            </li>
          ))}
        </ol>
      </section>
      <Reveal className="eh-prose" delay={SHELF.length * 160 + 200}>
        <p>
          The last frame is another collection. Shelves nest. The one thing a collection cannot hold is itself.
        </p>
      </Reveal>
    </>
  );
}

export const COLLECTION_HELP: KindHelpModule = {
  kind: 'collection',

  story: {
    logline: 'A shelf you build by hand, where a task, a doc and a memory can sit side by side in the order you chose.',

    opening: (
      <>
        <p>
          A collection is a named set you curate. You pick the things that belong together, of any kind, and put them
          in an order. Nothing lands in it by rule or by query. Every item is there because someone put it there.
        </p>
        <p>
          Every other grouping in the graph is one its structure imposes: a task&apos;s subtree, a channel&apos;s
          feed, a list filtered by kind. None of them can say &quot;these four things, from four
          different corners of the Space, are the launch.&quot; A collection can.
        </p>
      </>
    ),

    beats: [
      {
        eyebrow: 'The signature',
        title: 'Membership is an edge',
        body: <Shelf />,
      },
      {
        eyebrow: 'The rule',
        title: 'Order without duplicates',
        body: (
          <>
            <p>
              Add something without a position and it goes to the end, one past the highest position already on the
              shelf. Add something that is already there and it moves to the new position. It never appears twice.
            </p>
            <p>
              Taking an item out deletes the edge and nothing else. The entity keeps living wherever it lived before.
            </p>
          </>
        ),
      },
      {
        eyebrow: 'Why it is not a folder',
        title: 'Things can sit on many shelves',
        body: (
          <p>
            A collection does not own what it holds. The same doc can be on the launch shelf and the onboarding shelf
            at once, and neither one moves it out of its home. That is why the expanded row of every list carries a{' '}
            <strong>Collections</strong> picker, and why any list can be narrowed through a collection lens to just
            one set&apos;s members.
          </p>
        ),
      },
      {
        eyebrow: 'What the count means',
        title: 'Archived items step back, not out',
        body: (
          <p>
            The item count on a collection counts live members only. Archive something on the shelf and the count
            drops, but its edge stays. Restore it and it is back in place, in the same position. A membership pointing
            at an archived entity can still be removed, so a shelf can always be tidied.
          </p>
        ),
      },
    ],

    lifecycle: [
      { name: 'Named', note: 'Created like any entity, with a title and an optional description.' },
      { name: 'Gathering', note: 'Items are added from any kind, each one a contains edge with a position.' },
      { name: 'Reordered', note: 'Adding an item again moves it. It never appears twice.' },
      { name: 'Pruned', note: 'Removing an item deletes the edge. The item itself is untouched.' },
      { name: 'Archived', note: 'The collection becomes a tombstone. Restore it and its shelf comes back whole.' },
    ],
  },

  toolkit: {
    intro: (
      <p>
        From a terminal a collection is two verbs and a read. You create it like any entity, then membership has its
        own pair of commands so you never have to spell the <code>contains</code> edge or work out the next position
        yourself.
      </p>
    ),

    scenes: [
      {
        title: 'Build the shelf',
        narrative: (
          <p>
            Create the collection, then add to it. Leave <code>--position</code> off and each item lands at the end,
            so the order you type is the order it keeps. A collection is itself an entity, so it can go on another
            shelf the same way.
          </p>
        ),
        commands: ['entity create', 'collection add'],
        demo: [
          '# a shelf, then three things of three kinds',
          'tm8 entity create collection "Q3 billing launch"',
          'tm8 collection add <collection-id> <task-id>',
          'tm8 collection add <collection-id> <doc-id>',
          'tm8 collection add <collection-id> <memory-id>',
        ],
      },
      {
        title: 'Rearrange and prune',
        narrative: (
          <p>
            Positions are numbers, not slots, so you can slide something between two items without touching the
            rest. Adding an existing member with a new position moves it. <code>tm8 collection remove</code> takes it
            off the shelf and asks for <code>--yes</code>, because the edge goes. The entity stays.
          </p>
        ),
        commands: ['collection add', 'collection remove'],
        demo: [
          '# move the doc to the front, then drop the memory',
          'tm8 collection add <collection-id> <doc-id> --position 0.5',
          'tm8 collection remove <collection-id> <memory-id> --yes',
        ],
      },
      {
        title: 'Read what is on it',
        narrative: (
          <p>
            A collection&apos;s items are its outgoing <code>contains</code> edges, so the edge list answers directly.
            Asking the other way round, with the entity as target, tells you every shelf a thing sits on.
          </p>
        ),
        commands: ['edge list', 'entity context'],
        demo: [
          '# what is on the shelf',
          'tm8 edge list --source <collection-id> --type contains',
          '# which shelves hold this doc',
          'tm8 edge list --target <doc-id> --type contains',
        ],
      },
    ],

    nouns: ['edge'],
  },

  constellation: {
    intro: (
      <p>
        A collection has one wire that matters more than the rest. <code>contains</code> runs from the collection to
        any kind at all, which is why its brightest star is the wildcard. Everything else it touches, it touches the
        way most entities do.
      </p>
    ),

    notes: {
      'contains:outgoing':
        'Curated membership. One edge per item, props.position sets the order, and the collection itself is refused.',
      'pulled:incoming': 'A member or teammate taking a local projection of the collection.',
      'attached_to:outgoing':
        'The collection pinned as context to something else. Attached to a channel, it can power a hub tab or a pinned shelf.',
      'attached_to:incoming': 'Context attached to the collection itself, rather than placed on its shelf.',
      relates_to: 'The general-purpose link, when being on the shelf is not the point.',
    },

    spotlight: ['member', 'team_member', 'task', 'doc'],
  },
};
