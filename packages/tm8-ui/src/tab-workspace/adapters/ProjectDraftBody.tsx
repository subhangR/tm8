/**
 * `project` draft body (task 01a13ba3): the Projects list's ＋ in the tab
 * workspace opens the SAME Add project sheet the classic list hosts
 * (`projects/AddProjectSheet`, task 01a13574) — a folder on the node, an
 * uploaded folder, or a GitHub clone. Without this the workspace refused the
 * ＋ ("Projects can't be created here"), because a project has no generic
 * create.
 *
 * The sheet owns its three sources and commits them itself; this body only
 * binds the result. A node without `seam.spaceProjects` says so in place.
 */
import { useMemo } from 'react';
import type { SpaceId } from '@tm8/contract';
import { AddProjectSheet, addProjectPort } from '../../projects';
import { useWorkspace } from '../view/context';
import type { DraftHostProps } from './draft';
import '../view/creation.css';

export function ProjectDraftBody({ onCreated, onCreatedUnbound, onCancel }: DraftHostProps) {
  const { gate, spaceId } = useWorkspace();
  const port = useMemo(() => addProjectPort(gate.data.seam, spaceId as SpaceId), [gate.data.seam, spaceId]);
  if (!port) {
    return (
      <div className="tws-draft" data-testid="tws-draft-project">
        <p role="alert">This node cannot add projects to this space.</p>
      </div>
    );
  }
  return (
    <div className="tws-draft" data-testid="tws-draft-project">
      <AddProjectSheet
        nodeLabel="this node"
        port={port}
        onAdded={(id) => (id ? onCreated(id, 'project') : onCreatedUnbound('project'))}
        onCancel={onCancel}
      />
    </div>
  );
}
