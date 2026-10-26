/**
 * Recent project files as ⌘K rows (#1102's palette `views` source). The
 * palette has no project-wide file search (a project lists one folder per
 * read), so it offers the files this viewer opened, newest first, under the
 * same label a tab shows: name, then project and path.
 *
 * The row id is `file:<encodeURIComponent(projectId \0 path)>`: GateApp
 * splits ids at the FIRST `:` only, and the encoded ref carries none.
 */
import type { PaletteView } from '../shell/CommandPalette';
import { FileTypeBadge } from './FileTypeBadge';
import { baseName, isProjectFilePath, projectFileKey, type ProjectFileTarget } from './paths';

export const FILE_PALETTE_SCOPE = 'file';
export const PALETTE_FILE_LIMIT = 8;

export function filePaletteId(target: ProjectFileTarget): string {
  return `${FILE_PALETTE_SCOPE}:${encodeURIComponent(projectFileKey(target))}`;
}

/** The target a palette ref (the part after `file:`) names, or null. */
export function parseFilePaletteRef(ref: string): ProjectFileTarget | null {
  let key: string;
  try {
    key = decodeURIComponent(ref);
  } catch {
    return null;
  }
  const at = key.indexOf('\u0000');
  if (at <= 0) return null;
  const projectId = key.slice(0, at);
  const path = key.slice(at + 1);
  return isProjectFilePath(path) ? { projectId, path } : null;
}

/** "a.ts — tm8 · src/a.ts" */
export function fileRowLabel(target: ProjectFileTarget, projectName: string | null | undefined): string {
  return `${baseName(target.path)} — ${projectName ?? 'Project'} · ${target.path}`;
}

/** A recent file matches a query in its path or its project's name. */
export function fileMatches(target: ProjectFileTarget, projectName: string | null | undefined, query: string): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  return target.path.toLowerCase().includes(q) || (projectName ?? '').toLowerCase().includes(q);
}

export function recentFilePaletteViews(
  recent: readonly ProjectFileTarget[],
  projectNames: ReadonlyMap<string, string>,
  query = '',
  limit = PALETTE_FILE_LIMIT,
): PaletteView[] {
  const shown = recent.filter((target) => fileMatches(target, projectNames.get(target.projectId), query));
  return shown.slice(0, limit).map((target) => ({
    id: filePaletteId(target),
    label: fileRowLabel(target, projectNames.get(target.projectId)),
    glyph: <FileTypeBadge path={target.path} />,
  }));
}
