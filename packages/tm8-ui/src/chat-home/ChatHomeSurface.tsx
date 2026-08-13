import { lazy, Suspense, useMemo, useSyncExternalStore } from 'react';
import type { EntityId, SpaceId } from '@tm8/contract';
import type { Seam } from '../data/seam';
import {
  modelCatalog,
  modelCatalogVersion,
  subscribeModelCatalog,
} from '../domain/model-catalog';
import { createChatHomePortFromSeam, type ChatHomeL2Bridge } from './real-port';
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
}

/** Production route boundary: Chat and its markdown renderer stay out of non-Home chunks. */
export function ChatHomeSurface({ seam, nodeKey, bridge, ...screen }: ChatHomeSurfaceProps) {
  useSyncExternalStore(subscribeModelCatalog, modelCatalogVersion, modelCatalogVersion);
  const port = useMemo(() => createChatHomePortFromSeam(seam, bridge), [bridge, seam]);
  const models = modelCatalog(nodeKey).map((model) => ({
    model: model.model,
    label: model.label,
    provider: model.provider,
    agentTool: model.agentTool,
    ...(model.note ? { note: model.note } : {}),
  }));

  const props: ChatHomeScreenProps = { ...screen, port, models };
  return (
    <Suspense fallback={<div className="tch-load" role="status">Loading Chat…</div>}>
      <SplitChatHomeScreen {...props} />
    </Suspense>
  );
}

