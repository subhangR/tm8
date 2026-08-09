/**
 * TWO KINDS OF ROOT, AND THE REFUSAL TO MERGE THEM.
 *
 * The Files screen browses two things that look identical once they are drawn
 * as a tree and are not remotely the same:
 *
 *   LINKED PROJECT — a live directory on the node. What you see is what the
 *     agents see. It changes UNDER YOU: the tree you are looking at may already
 *     be wrong.
 *   SPACE FOLDER   — a tree the user uploaded, named by them, owned by the
 *     Space. Immutable until it is uploaded again. It cannot go stale in the
 *     first sense and is ALWAYS stale in the second: it is a snapshot of a
 *     moment that has passed.
 *
 * Their staleness properties are opposite, so the remedy for a surprising
 * result is opposite too — re-read one, re-upload the other. A user who cannot
 * tell which one they are looking at cannot choose. That is why the kind is
 * STATED on the screen rather than implied by an icon or by which group of a
 * dropdown the row happened to sit in, and why this module exists as a type
 * rather than a boolean somewhere in the component.
 *
 * The VIEW MODELS below exist for the same reason in the other direction: the
 * two roots answer two different DTOs and the panes render one shape. Adapting
 * at the edge keeps a single renderer honest about both, and keeps the
 * renderer from having to care which lane owns which DTO.
 */
import type { ProjectFileContent, ProjectFileListing } from '@tm8/contract';

import type { SpaceFolderContent, SpaceFolderListing, SpaceFolderSummary } from './space-folders';

export type RootKind = 'project' | 'space-folder';

export type FilesRoot =
  | { kind: 'project'; id: string; name: string }
  | { kind: 'space-folder'; id: string; name: string; summary: SpaceFolderSummary };

/** The group headings. Each names the kind AND its staleness property. */
export const ROOT_KIND_COPY: Record<RootKind, { group: string; banner: string }> = {
  project: {
    group: 'Linked projects — live on this node',
    banner:
      'LIVE — this is the working directory on the node, exactly as the agents see it. It can change while you look at it; re-read to see the current state.',
  },
  'space-folder': {
    group: 'Space folders — uploaded snapshots',
    banner:
      'SNAPSHOT — this is a folder you uploaded, owned by this Space. It does not change on its own and no agent writes to it; upload again to replace it.',
  },
};

export interface DirView {
  path: string;
  parentPath: string | null;
  separator: string;
  /** The path everything is shown relative to, so crumbs hide the absolute prefix. */
  rootPath: string;
  directories: readonly { name: string; path: string }[];
  files: readonly { name: string; path: string; sizeBytes: number | null }[];
  truncated: boolean;
}

export interface FileView {
  path: string;
  mime: string | null;
  sizeBytes: number | null;
  encoding: 'utf8' | 'base64' | 'none';
  text: string | null;
  base64: string | null;
  refusal: { reason: string; detail?: string | null } | null;
}

export function dirViewOfProject(listing: ProjectFileListing): DirView {
  return {
    path: listing.path,
    parentPath: listing.parentPath,
    separator: listing.separator,
    rootPath: listing.workingDir,
    directories: listing.directories.map((dir) => ({ name: dir.name, path: dir.path })),
    files: listing.files.map((file) => ({
      name: file.name, path: file.path, sizeBytes: file.sizeBytes,
    })),
    truncated: listing.truncated,
  };
}

/**
 * A Space folder's listing carries NEITHER `parentPath` NOR `separator` — its
 * paths are relative to the folder and its root is `''`. The parent is
 * therefore DERIVED, and the derivation has one case worth naming: the parent
 * of a first-level directory is `''`, which is the ROOT and not "no parent".
 * Treating that empty string as absent is how a tree loses its way back up.
 */
export function parentOfRelativePath(path: string): string | null {
  if (path === '') return null;
  const cut = path.lastIndexOf('/');
  return cut === -1 ? '' : path.slice(0, cut);
}

export function dirViewOfFolder(listing: SpaceFolderListing): DirView {
  return {
    path: listing.path,
    parentPath: parentOfRelativePath(listing.path),
    separator: '/',
    // A Space folder's paths are already folder-relative, so the root prefix to
    // hide is empty rather than an absolute working directory.
    rootPath: '',
    directories: listing.directories.map((dir) => ({ name: dir.name, path: dir.path })),
    files: listing.files.map((file) => ({
      name: file.name, path: file.path, sizeBytes: file.sizeBytes ?? null,
    })),
    truncated: listing.truncated,
  };
}

export function fileViewOfProject(content: ProjectFileContent): FileView {
  return {
    path: content.path,
    mime: content.mime,
    sizeBytes: content.sizeBytes,
    encoding: content.encoding,
    text: content.text,
    base64: content.base64,
    refusal: content.refusal,
  };
}

export function fileViewOfFolder(content: SpaceFolderContent): FileView {
  return {
    path: content.path,
    // The folder contract names this `mediaType`; the project contract names
    // the same fact `mime`. One view model, so the panes never learn either.
    mime: content.mediaType,
    sizeBytes: content.sizeBytes,
    encoding: content.encoding,
    text: content.text,
    base64: content.base64,
    refusal: content.refusal,
  };
}

/** Path segments between the root and the current directory. */
export function crumbsOf(view: DirView): { label: string; path: string }[] {
  const { rootPath, path, separator } = view;
  if (rootPath !== '' && !path.startsWith(rootPath)) return [];
  const rest = path.slice(rootPath.length).split(separator).filter(Boolean);
  let walked = rootPath;
  return rest.map((segment) => {
    walked = walked === '' ? segment : `${walked}${separator}${segment}`;
    return { label: segment, path: walked };
  });
}
