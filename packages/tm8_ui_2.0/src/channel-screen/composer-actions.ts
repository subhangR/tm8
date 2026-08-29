import type { ComposerInteractionPolicy } from '@tm8/contract';

export interface DiscoveredComposerActions {
  canPost: boolean;
  canMention: boolean;
  canAttach: boolean;
}

const FILE_UPLOAD_OPERATIONS = [
  'files.uploadInit',
  'files.uploadComplete',
  'files.uploadAbort',
] as const;

/** Immutable profile bindings are the capability source; JSX never guesses. */
export function discoverComposerActions(
  policy: ComposerInteractionPolicy | null | undefined,
): DiscoveredComposerActions {
  const bindings = new Set<string>(policy?.operationBindings ?? []);
  const canPost = bindings.has('messages.post');
  return {
    canPost,
    canMention: canPost,
    canAttach: Boolean(
      canPost
      && policy?.supportsAttachments
      && policy.allowedAttachmentKinds.includes('file')
      && FILE_UPLOAD_OPERATIONS.every((operation) => bindings.has(operation)),
    ),
  };
}
