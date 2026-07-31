import { createContext, useContext, type ReactNode } from 'react';
import type { EntityId } from '../../../types/contract';
import type { ChannelTagTarget, TaggedChannelMessageResult } from './model';

export interface ChannelTaggingController {
  loadTargets(spaceId: string): Promise<ChannelTagTarget[]>;
  send(input: {
    spaceId: string;
    channelId: EntityId;
    body: string;
    selectedTagIds: readonly EntityId[];
    mentionIds?: readonly EntityId[];
    attachmentIds?: readonly EntityId[];
  }): Promise<TaggedChannelMessageResult>;
}

const ChannelTaggingContext = createContext<ChannelTaggingController | null>(null);

export function ChannelTaggingProvider({
  controller,
  children,
}: {
  controller: ChannelTaggingController;
  children: ReactNode;
}) {
  return (
    <ChannelTaggingContext.Provider value={controller}>
      {children}
    </ChannelTaggingContext.Provider>
  );
}

/** Null in the backend-agnostic mock world, where work sessions do not exist. */
export function useChannelTagging(): ChannelTaggingController | null {
  return useContext(ChannelTaggingContext);
}
