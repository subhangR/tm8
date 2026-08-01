/**
 * THE CHAT COMPOSER'S BINDING TO THE ONE UPLOAD TASK.
 *
 * The lifecycle itself moved to `files/upload.ts` when the entity panel's
 * attachment strip became a second caller — see that file's header for why a
 * copy was not acceptable. What stays here is the single thing that is
 * genuinely the CHAT's: mutation ids come from this lane's `uuidV7`, because
 * the chat journal orders optimistic entries by them. Nothing else differs, so
 * nothing else is restated.
 *
 * The old names are kept as aliases: the composer, ChannelScreen,
 * SessionChatSurface and ChannelView all speak them, and renaming four call
 * sites to prove a refactor happened is churn, not evidence.
 */
import type { EntityId, SpaceId } from '@tm8/contract';
import type { Seam } from '../data/seam';
import {
  createFileUploadTask,
  UploadCancelledError,
  type FileUploadTask,
  type UploadedFile,
} from '../files/upload';
import { uuidV7 } from './chat-mutations';

export type UploadedChatAttachment = UploadedFile;
export type ChatAttachmentUploadTask = FileUploadTask;
export const ChatUploadCancelledError = UploadCancelledError;
export { safeUploadReason, sha256Hex } from '../files/upload';

export function createChatAttachmentUploadTask(options: {
  files: Seam['files'];
  file: File;
  spaceId: SpaceId | string;
  anchorId: EntityId;
  newMutationId?: () => string;
  checksum?: (file: Blob) => Promise<string>;
}): ChatAttachmentUploadTask {
  return createFileUploadTask({ newMutationId: uuidV7, ...options });
}
