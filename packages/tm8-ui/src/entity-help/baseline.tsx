/**
 * THE BASELINE PAGE — what every kind shows before anyone writes its story.
 *
 * NEVER BLANK, NEVER "COMING SOON". A kind with no module in `kinds/` still
 * gets three full tabs, and every sentence of them is DERIVED from data the
 * application already ships:
 *
 *   the registry     `KindConfig` — label, how it is born (`list.quickStart`,
 *                    `quickCreate`, `createForm`), how it is listed
 *                    (`defaultMode`, `hiddenModes`, `list.categories`), what
 *                    its panel is (`panel.archetype`), whether it launches a
 *                    session, and where Settings manages it;
 *   the edge registry`domain/edge-kinds` — every edge type that admits the
 *                    kind at either end, with the human verb from
 *                    `EDGE_VERBS`;
 *   the help catalog `@tm8/cli/discovery` — the nouns and commands that act
 *                    on it, live.
 *
 * Because the words are derived, the baseline is honest by construction: it
 * can say a task is "started, not authored" only because the registry says
 * `quickStart`. What it cannot do is tell the reader WHY — that is the
 * authored story's job, and the reason wave workers exist.
 */
import type { ReactNode } from 'react';
import {
  edgeVerb,
  getKind,
  relationsOf,
  resolveAction,
  type BodyArchetype,
  type CollectionMode,
  type KindConfig,
  type KindRelation,
} from '../domain';
import { kindToolkitCatalog, type CommandDiscovery } from './catalog';
import type { ConstellationContent, LifecycleStage, StoryContent, ToolkitContent, ToolkitScene } from './types';

const MODE_WORDS: Readonly<Record<CollectionMode, string>> = {
  list: 'a list',
  board: 'a board',
  tree: 'a tree',
  feed: 'a feed',
  gallery: 'a gallery',
  graph: 'a graph',
};

/** What a panel archetype means to the person reading it. */
const ARCHETYPE_SENTENCE: Readonly<Record<BodyArchetype, string>> = {
  subtree: 'Its panel is a subtree: its own children sit under it as rows, and the work nests.',
  reader: 'Its panel is a reader: a page to be read top to bottom, edited in place.',
  hub: 'Its panel is a hub: a front door with regions, and the discussion feed hanging off it.',
  profile: 'Its panel is a profile: who or what this is, and what it carries.',
  generic: 'Its panel is the generic body: ordered blocks, each answering one question.',
  equipment: 'Its panel is equipment: a file-backed body with the tools it brings along.',
  terminal: 'Its panel is a terminal: the live surface itself, streamed as it runs.',
  governed: 'Its panel is governed: its state is owned by a process, and the panel reports it.',
  restricted: 'Its panel is restricted: managed by a named writer, read here.',
  conversation: 'Its panel IS the conversation: the transcript is the body, not a tab on it.',
  machine: 'Its panel is a machine: the surfaces of a running container, and the controls over it.',
};

function bornSentence(config: KindConfig): string {
  const plural = config.labelPlural.toLowerCase();
  const single = config.label.toLowerCase();
  const verb = config.list.quickStart;
  if (verb) {
    const def = resolveAction(verb);
    return `${config.labelPlural} are started, not authored: the birth verb is “${def.label}”, and a new ${single} exists the moment it is performed.`;
  }
  if (config.createForm) {
    return `A ${single} is made through its own form rather than a bare title — it needs more than a name before it can exist.`;
  }
  if (!config.list.quickCreate) {
    return `${config.labelPlural} are not created from a list header. Each arrives through its own door — a Settings section, a named writer, or the system itself.`;
  }
  return `A ${single} is born the instant you press New: an Untitled ${single} opens, and naming it is the first edit. ${config.labelPlural} are cheap to make, so ${plural} can be made speculatively and archived without ceremony.`;
}

function listedSentence(config: KindConfig): string {
  const shown = (['list', 'board', 'tree', 'feed', 'gallery', 'graph'] as const).filter(
    (mode) => !config.hiddenModes.includes(mode),
  );
  const others = shown.filter((mode) => mode !== config.defaultMode).map((mode) => MODE_WORDS[mode]);
  const tail = others.length > 0 ? `, and can also be arranged as ${joinWords(others)}` : '';
  return `${config.labelPlural} list as ${MODE_WORDS[config.defaultMode]} by default${tail}.`;
}

function joinWords(words: readonly string[]): string {
  if (words.length <= 1) return words.join('');
  return `${words.slice(0, -1).join(', ')} or ${words[words.length - 1]}`;
}

/** The lifecycle filmstrip: the list's status categories when it has them. */
export function baselineLifecycle(config: KindConfig): LifecycleStage[] {
  const categories = config.list.categories ?? [];
  if (categories.length > 0) {
    return categories.map((tab) => ({
      name: tab.label,
      note: `Listed under the “${tab.label}” tab.`,
    }));
  }
  return [
    { name: 'Created', note: `A ${config.label.toLowerCase()} enters the graph with a title, a kind and a Space.` },
    { name: 'In the graph', note: 'Read, edited, related and discussed by anyone the Space admits.' },
    { name: 'Archived', note: 'A tombstone, never an erasure: it can be restored, and its history stays.' },
  ];
}

/** Relations that NAME the kind first, wildcard admissions after; deduplicated by type. */
export function rankedRelations(kind: string): KindRelation[] {
  const all = relationsOf(kind);
  const named = all.filter((relation) => !relation.viaWildcard);
  const wild = all.filter((relation) => relation.viaWildcard);
  return [...named, ...wild];
}

function relationSentence(kind: string, relations: readonly KindRelation[]): string {
  const config = getKind(kind);
  const named = relations.filter((relation) => !relation.viaWildcard);
  const peers = new Set<string>();
  for (const relation of named) for (const peer of relation.peers) if (peer !== '*' && peer !== kind) peers.add(peer);
  const peerLabels = [...peers].slice(0, 5).map((peer) => getKind(peer).labelPlural.toLowerCase());
  if (named.length === 0) {
    return `The edge registry names no relation that is ${config.label.toLowerCase()}-specific; a ${config.label.toLowerCase()} relates to other entities through the general-purpose edges every kind shares.`;
  }
  return `The edge registry names ${named.length} relation${named.length === 1 ? '' : 's'} with a ${config.label.toLowerCase()} at one end${
    peerLabels.length > 0 ? ` — reaching ${joinWords(peerLabels)}` : ''
  }. The Constellation tab draws them.`;
}

export function baselineStory(kind: string): StoryContent {
  const config = getKind(kind);
  const single = config.label.toLowerCase();
  const relations = rankedRelations(kind);
  const beats: StoryContent['beats'] = [
    {
      eyebrow: 'How it is born',
      title: bornSentence(config).split(':')[0]?.replace(/\.$/, '') ?? 'Birth',
      body: <p>{bornSentence(config)}</p>,
    },
    {
      eyebrow: 'Where you meet it',
      title: `In the list, and in its panel`,
      body: (
        <>
          <p>{listedSentence(config)}</p>
          <p>{ARCHETYPE_SENTENCE[config.panel.archetype]}</p>
          {config.settingsHome ? (
            <p>
              It is managed in Settings, under <strong>{config.settingsHome.label}</strong>; the list is where you
              find one, Settings is where you change what it is.
            </p>
          ) : null}
          {config.launchable ? (
            <p>A work session can be launched on a {single}: the session links to it and works from it.</p>
          ) : null}
        </>
      ),
    },
    {
      eyebrow: 'What it touches',
      title: 'Its place in the graph',
      body: <p>{relationSentence(kind, relations)}</p>,
    },
  ];
  return {
    logline: `One of the ${config.labelPlural.toLowerCase()} — an entity kind in the tm8 graph, with its own list, its own panel and its own commands.`,
    opening: (
      <>
        <p>
          A <strong>{single}</strong> is an entity: it has an id, a title, a version, a Space, and a place in the
          graph that every other entity can point at. Everything below is read from the registry that draws it, the
          edge types that admit it and the command catalog that acts on it — so it is true of this build, and only
          this build.
        </p>
        <p>
          This is the baseline page. A written story for {config.labelPlural.toLowerCase()} replaces it once a
          teammate authors one; until then the facts stand on their own.
        </p>
      </>
    ),
    beats,
    lifecycle: baselineLifecycle(config),
  };
}

export function baselineToolkit(kind: string): ToolkitContent {
  const config = getKind(kind);
  const catalog = kindToolkitCatalog(kind);
  const scenes: ToolkitScene[] = [];
  if (catalog.own.length > 0) {
    scenes.push({
      title: `The ${config.label.toLowerCase()} verbs`,
      narrative: (
        <p>
          {catalog.nouns.length > 0 ? (
            <>
              The catalog files these under{' '}
              {catalog.nouns.map((noun, i) => (
                <span key={noun.name}>
                  {i > 0 ? ' and ' : ''}
                  <code>tm8 {noun.name}</code>
                </span>
              ))}
              {' — '}
              {catalog.nouns.map((noun) => noun.summary.toLowerCase()).join('; ')}.
            </>
          ) : (
            <>
              No noun of its own: a {config.label.toLowerCase()} is worked through the commands below and the generic
              entity family after them.
            </>
          )}
        </p>
      ),
      commands: catalog.own.map((row) => row.command),
    });
  }
  scenes.push({
    title: 'Every entity, including this one',
    narrative: (
      <p>
        Orient with <code>tm8 entity context</code> before any other read — it returns the summary, the hierarchy,
        recent messages and the actions you are allowed, with the current version, in one bounded call. Then read,
        change, relate and talk with the rest.
      </p>
    ),
    commands: catalog.generic.map((row) => row.command),
  });
  return {
    intro: (
      <p>
        These commands are read from the CLI’s own catalog at render time — the same rows{' '}
        <code>tm8 help &lt;noun&gt; --format json</code> prints — so what you see here is what the binary in this
        build answers to.
      </p>
    ),
    scenes,
  };
}

export function baselineConstellation(kind: string): ConstellationContent {
  const config = getKind(kind);
  const relations = rankedRelations(kind);
  const named = relations.filter((relation) => !relation.viaWildcard);
  return {
    intro: (
      <p>
        {named.length > 0 ? (
          <>
            {config.labelPlural} sit at one end of {named.length} named edge type{named.length === 1 ? '' : 's'}.
            Each line below is a registered relation, read from the {config.label.toLowerCase()}’s side:{' '}
            {named
              .slice(0, 3)
              .map((relation) => `“${edgeVerb(relation.type, relation.direction)}”`)
              .join(', ')}
            {named.length > 3 ? ', and more' : ''}. Press a neighbour to read its own page.
          </>
        ) : (
          <>
            No edge type names {config.labelPlural.toLowerCase()} specifically; the relations drawn here are the
            ones every kind shares. Press a neighbour to read its own page.
          </>
        )}
      </p>
    ),
  };
}

/** Everything the baseline knows about a kind's commands — exposed for tests. */
export function baselineCommandsOf(kind: string): CommandDiscovery[] {
  const catalog = kindToolkitCatalog(kind);
  return [...catalog.own, ...catalog.generic];
}

/** A React node's presence, for tests that assert non-emptiness. */
export function hasContent(node: ReactNode): boolean {
  return node !== null && node !== undefined && node !== false && node !== '';
}
