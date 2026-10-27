/**
 * Project file tabs: read-only views of files in a connected project folder.
 *
 * A file is not an entity, so its tab is keyed by `{projectId, path}` (path
 * project-RELATIVE, '/'-separated; see `project-file/paths.ts`). Opening goes
 * through `workspace.files.open`, the one command for it: an already open file
 * is focused (and pinned by a keep open), a preview open replaces the current
 * preview tab, and a new tab lands right after the active one.
 *
 * `openProjectFile` is THE open API for callers (the project tree, Recent,
 * ⌘K): `preview: true` for a single click, `false` (the default) to keep.
 */
import { useCallback, useEffect } from 'react';
import { baseName, folderSegments, type ProjectFileTarget } from '../../project-file/paths';
import { useProjectName } from '../../project-file/projects';
import { ProjectFileViewer } from '../../project-file/ProjectFileViewer';
import { recordRecentProjectFile } from '../../project-file/recent';
import { getWorkspaceRuntime, type WorkspaceRuntime } from '../runtime/dispatch';
import type { FileTabRecord, Result, Source, TabRecord } from '../runtime/types';
import { useWorkspace, useWorkspaceState } from '../view/context';

export interface OpenProjectFileOptions {
  /** A preview tab (italic) that the next preview open replaces. Default false: a kept tab. */
  preview?: boolean;
  /** Default true. False opens it behind the active tab. */
  activate?: boolean;
  /** Default `click`. */
  source?: Source;
}

/** Open (or focus) `target` as a file tab in `runtime`. */
export function openProjectFile(
  runtime: Pick<WorkspaceRuntime, 'dispatch'>,
  target: ProjectFileTarget,
  options: OpenProjectFileOptions = {},
): Result {
  return runtime.dispatch({
    command: 'workspace.files.open',
    args: {
      projectId: target.projectId,
      path: target.path,
      preview: options.preview ?? false,
      ...(options.activate === false ? { activate: false } : {}),
    },
    source: options.source ?? 'click',
  });
}

/** Gate-side open (⌘K, outside the Workspace view): the viewer's runtime for the space. */
export function openProjectFileInWorkspace(
  viewerId: string,
  spaceId: string,
  target: ProjectFileTarget,
  options: OpenProjectFileOptions = {},
): Result {
  return openProjectFile(getWorkspaceRuntime(viewerId, spaceId), target, { source: 'palette', ...options });
}

/** `openProjectFile` bound to the Workspace in context. */
export function useOpenProjectFile(): (target: ProjectFileTarget, options?: OpenProjectFileOptions) => Result {
  const { runtime } = useWorkspace();
  return useCallback((target, options) => openProjectFile(runtime, target, options), [runtime]);
}

/** Pin a preview tab (double-click on the tab): the same open, as a keep. */
export function pinFileTab(runtime: Pick<WorkspaceRuntime, 'dispatch'>, tab: FileTabRecord, source: Source = 'click'): void {
  if (!tab.preview) return;
  openProjectFile(runtime, tab, { preview: false, source });
}

/**
 * What tells same-named open files apart (mockup v2: `index.ts · files`):
 * the parent folder when the twins share a project, the project name when
 * they don't (both when both are needed). Null when the name is unique.
 */
export function fileTabDetail(
  tab: Pick<FileTabRecord, 'projectId' | 'path'>,
  openFiles: readonly Pick<FileTabRecord, 'projectId' | 'path'>[],
  projectName: string | null,
): string | null {
  const name = baseName(tab.path);
  const twins = openFiles.filter(
    (t) => baseName(t.path) === name && !(t.projectId === tab.projectId && t.path === tab.path),
  );
  if (twins.length === 0) return null;
  const project = projectName ?? 'project';
  const folder = folderSegments(tab.path).at(-1) ?? project;
  const otherProject = twins.some((t) => t.projectId !== tab.projectId);
  const sameProject = twins.some((t) => t.projectId === tab.projectId);
  if (otherProject && sameProject) return `${project}/${folder}`;
  return otherProject ? project : folder;
}

/** The label, detail and tooltip a file tab shows. */
export function useFileTabFacts(tab: TabRecord): { title: string; detail: string | null; tooltip: string } | null {
  const { gate, spaceId } = useWorkspace();
  const file = tab.type === 'file' ? tab : null;
  const projectName = useProjectName(gate.data.seam, spaceId, file?.projectId ?? '');
  const openFiles = useWorkspaceState((s) => s.tabs);
  if (!file) return null;
  const files = Object.values(openFiles).filter((t): t is FileTabRecord => t.type === 'file');
  const project = projectName ?? 'Project';
  return {
    title: baseName(file.path),
    detail: fileTabDetail(file, files, projectName),
    tooltip: `${project} — ${file.path}${file.preview ? ' (preview)' : ''}`,
  };
}

/**
 * The file tab's body. Keyed on project+path by the host (a preview tab keeps
 * its id when the next preview replaces it). Every open lands here, so this is
 * where a file joins the viewer's Recent list.
 */
export function ProjectFileTab({ tab }: { tab: FileTabRecord }) {
  const { gate, spaceId, viewerId } = useWorkspace();
  const projectName = useProjectName(gate.data.seam, spaceId, tab.projectId);
  const { projectId, path } = tab;
  useEffect(() => {
    recordRecentProjectFile(viewerId, spaceId, { projectId, path });
  }, [viewerId, spaceId, projectId, path]);
  return <ProjectFileViewer seam={gate.data.seam} target={{ projectId, path }} projectName={projectName} />;
}
