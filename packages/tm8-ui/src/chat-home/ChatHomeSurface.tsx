import { lazy, Suspense, useMemo, useSyncExternalStore } from 'react';
import type { EntityId, SpaceId } from '@tm8/contract';
import type { Seam } from '../data/seam';
import {
  modelCatalog,
  modelCatalogVersion,
  subscribeModelCatalog,
} from '../domain/model-catalog';
import { attachmentsPortFromSeam } from '../files/port';
import type { TriggerOption } from '../rich-input';
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
  /**
   * Skills the composer's `/` can reference (R1). Passed down from the gate,
   * which reads them once per space rather than once per surface. Absent ⇒
   * `/` types plain text.
   */
  skillOptions?: readonly TriggerOption[];
}

/** Production route boundary: Chat and its markdown renderer stay out of non-Home chunks. */
export function ChatHomeSurface({ seam, nodeKey, bridge, onOpenEntity, ...screen }: ChatHomeSurfaceProps) {
  useSyncExternalStore(subscribeModelCatalog, modelCatalogVersion, modelCatalogVersion);
  const port = useMemo(() => createChatHomePortFromSeam(seam, bridge), [bridge, seam]);
  /**
   * The SAME upload lifecycle every attachment strip in the app uses, bound
   * to this space. The anchor is supplied per call by the screen, which is
   * the only place that knows whether this is bare Home (the seeded default
   * channel) or a contextual chat on some other entity.
   */
  const attach = useMemo(
    () => attachmentsPortFromSeam(seam, screen.spaceId).startUpload,
    [seam, screen.spaceId],
  );
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

  const props: ChatHomeScreenProps = { ...screen, port, models, resolveEntity, onOpenEntity, attach };
  return (
    <Suspense fallback={<div className="tch-load" role="status">Loading Chat…</div>}>
      <SplitChatHomeScreen {...props} />
    </Suspense>
  );
}

