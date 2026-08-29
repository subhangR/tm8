import { describe, expect, it } from 'vitest';
import type { ComposerInteractionPolicy } from '@tm8/contract';
import { discoverComposerActions } from './composer-actions';

const all: ComposerInteractionPolicy = {
  schemaRef: 'tm8.composer.v1',
  supportsReply: true,
  supportsAttachments: true,
  allowedAttachmentKinds: ['file'],
  operationBindings: [
    'messages.post',
    'files.uploadInit',
    'files.uploadComplete',
    'files.uploadAbort',
  ],
};

describe('composer action discovery', () => {
  it('enables attachment and mention composition only from canonical operation bindings', () => {
    expect(discoverComposerActions(all)).toEqual({ canPost: true, canMention: true, canAttach: true });
  });

  it('does not infer upload from supportsAttachments or a partial operation set', () => {
    expect(discoverComposerActions({
      ...all,
      operationBindings: ['messages.post', 'files.uploadInit', 'files.uploadComplete'],
    })).toEqual({ canPost: true, canMention: true, canAttach: false });
    expect(discoverComposerActions({ ...all, supportsAttachments: false })).toEqual({
      canPost: true,
      canMention: true,
      canAttach: false,
    });
  });
});
