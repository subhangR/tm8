import { lazy, Suspense, useMemo, useSyncExternalStore } from 'react';
import type { EntityId, SpaceId } from '@tm8/contract';
import type { Seam } from '../data/seam';
import {
  modelCatalog,
  modelCatalogVersion,
  subscribeModelCatalog,
} from '../domain/model-catalog';
import { createChatHomePortFromSeam, type ChatHomeL2Bridge } from './real-port';
import type { ChatEntityResolver } from './EntityChip';
import type { ChatHomeScreenProps } from './ChatHomeScreen';

const SplitChatHomeScreen = lazy(async () => {
  const module = await import('./ChatHomeScreen');
  return { default: module.ChatHomeScreen };
});

export interface ChatHomeSurfaceProps {
  seam: Seam;
  spaceId: SpaceId | string;
  nodeKey: string;
  anchorId?: EntityId;
  spaceLabel?: string;
  bridge?: ChatHomeL2Bridge;
  /** The shell's entity-open verb: opens the right-side detail panel. */
  onOpenEntity?: (id: EntityId) => void;
}

/** Production route boundary: Chat and its markdown renderer stay out of non-Home chunks. */
export function ChatHomeSurface({ seam, nodeKey, bridge, onOpenEntity, ...screen }: ChatHomeSurfaceProps) {
  useSyncExternalStore(subscribeModelCatalog, modelCatalogVersion, modelCatalogVersion);
  const port = useMemo(() => createChatHomePortFromSeam(seam, bridge), [bridge, seam]);
  /** Bare-id tool references resolve through the same seam every panel reads. */
  const resolveEntity = useMemo<ChatEntityResolver>(
    () => async (id) => {
      const detail = await seam.entity(id);
      return { id, kind: detail.kind, title: detail.title };
    },
    [seam],
  );
  const models = modelCatalog(nodeKey).map((model) => ({
    model: model.model,
    label: model.label,
    provider: model.provider,
    agentTool: model.agentTool,
    ...(model.note ? { note: model.note } : {}),
  }));

  const props: ChatHomeScreenProps = { ...screen, port, models, resolveEntity, onOpenEntity };
  return (
    <Suspense fallback={<div className="tch-load" role="status">Loading Chat…</div>}>
      <SplitChatHomeScreen {...props} />
    </Suspense>
  );
}

