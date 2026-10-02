/**
 * RESOLVE A KIND'S PAGE — authored module over baseline, commands live.
 *
 * The one function the overlay calls. It answers for EVERY kind: a kind with
 * a module in `kinds/` gets its authored tabs, a kind without gets the
 * baseline's, and a module that authored only one tab gets the other two
 * from the baseline. The Toolkit's commands are resolved against the live
 * catalog here, so no component ever sees a command path it cannot render.
 */
import { getKind } from '../domain';
import {
  baselineConstellation,
  baselineStory,
  baselineToolkit,
  rankedRelations,
} from './baseline';
import { demoLinesFor, kindToolkitCatalog, resolveCommands, type CommandDiscovery, type KindToolkitCatalog } from './catalog';
import { kindHelpModule } from './kinds';
import type { ConstellationContent, StoryContent, ToolkitContent, ToolkitScene } from './types';

export interface ResolvedScene extends Omit<ToolkitScene, 'commands' | 'demo'> {
  readonly commands: readonly CommandDiscovery[];
  /** The typed terminal's lines — authored, or the catalog's own examples. */
  readonly demo: readonly string[];
  /** Paths the scene named that the catalog does not know, for the author's eye. */
  readonly unresolved: readonly string[];
}

export interface ResolvedToolkit {
  readonly intro: ToolkitContent['intro'];
  readonly scenes: readonly ResolvedScene[];
  /** The full live ledger for the kind, drawn after the scenes. */
  readonly catalog: KindToolkitCatalog;
}

export interface HelpPage {
  readonly kind: string;
  readonly label: string;
  readonly labelPlural: string;
  readonly story: StoryContent;
  readonly toolkit: ResolvedToolkit;
  readonly constellation: ConstellationContent;
  /** Which tabs came from an authored module — the header says so. */
  readonly authored: { readonly story: boolean; readonly toolkit: boolean; readonly constellation: boolean };
}

function resolveScene(scene: ToolkitScene): ResolvedScene {
  const commands = resolveCommands(scene.commands);
  const known = new Set(commands.map((row) => row.command));
  return {
    title: scene.title,
    narrative: scene.narrative,
    commands,
    demo: scene.demo ?? demoLinesFor(commands),
    unresolved: scene.commands.filter((path) => !known.has(path)),
  };
}

export function resolveHelp(kind: string): HelpPage {
  const config = getKind(kind);
  const module = kindHelpModule(kind);
  const story = module?.story ?? baselineStory(kind);
  const toolkitContent = module?.toolkit ?? baselineToolkit(kind);
  const toolkit: ResolvedToolkit = {
    intro: toolkitContent.intro,
    scenes: toolkitContent.scenes.map(resolveScene),
    catalog: kindToolkitCatalog(kind, { nouns: toolkitContent.nouns, commands: toolkitContent.commands }),
  };
  const constellation = module?.constellation ?? baselineConstellation(kind);
  return {
    kind,
    label: config.label,
    labelPlural: config.labelPlural,
    story,
    toolkit,
    constellation,
    authored: {
      story: module?.story !== undefined,
      toolkit: module?.toolkit !== undefined,
      constellation: module?.constellation !== undefined,
    },
  };
}

export { rankedRelations };
