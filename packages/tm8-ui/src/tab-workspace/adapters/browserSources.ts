/**
 * NON-ENTITY BROWSER SOURCES: what the browser column can show besides a
 * kind's entity list. Each row is DATA the rail and the browser read — a rail
 * button, a label, the panel drawn in place of the list — so a source never
 * teaches the browser or the rail about itself (the §15.2 no-branching law,
 * `panels/no-branching.test.ts`, applied to sources as to kinds).
 *
 * A source's contents are not entities (Project files: a connected folder's
 * files), so the selection lives beside the browser's kind, UI-local
 * (`runtime/browserSourceStore.ts`), not in the shared workspace state whose
 * `browsers.main.kind` is a D7 kind by contract. Picking a kind clears it.
 */
import type { ComponentType } from 'react';
import { ProjectFilesPanel } from '../../project-file/ProjectFilesPanel';

export interface BrowserSource {
  id: string;
  /** Rail label, tooltip and the panel's accessible name. */
  label: string;
  /** The rail button's drawn mark (16-unit paths, `VectorIcon`). */
  art: readonly string[];
  /** Drawn in the browser column while this source is selected. */
  Panel: ComponentType;
}

/** A folder holding code: distinct from the Files screen's open folder and the file kind. */
const PROJECT_FILES_ART: readonly string[] = [
  'M2.4 4.2a1.2 1.2 0 0 1 1.2-1.2h2.6l1.2 1.6h4.6a1.2 1.2 0 0 1 1.2 1.2v6.2a1.2 1.2 0 0 1-1.2 1.2H3.6a1.2 1.2 0 0 1-1.2-1.2z',
  'M6.6 7.6 5.2 9l1.4 1.4',
  'M9.4 7.6 10.8 9l-1.4 1.4',
];

const SOURCES: readonly BrowserSource[] = [
  { id: 'project-files', label: 'Project files', art: PROJECT_FILES_ART, Panel: ProjectFilesPanel },
];

export function browserSources(): readonly BrowserSource[] {
  return SOURCES;
}

/** The source registered under `id`; undefined for null or an id no longer registered. */
export function getBrowserSource(id: string | null): BrowserSource | undefined {
  return id === null ? undefined : SOURCES.find((s) => s.id === id);
}
