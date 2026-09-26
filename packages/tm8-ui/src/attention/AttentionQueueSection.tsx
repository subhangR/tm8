/**
 * The attention queue as a page section — Home's NEEDS YOU and the workspace
 * empty centre's "Needs attention" (chapter 4 tab 8). Both are the same list
 * with the same rows and order as the top-bar popover, hidden when nothing is
 * waiting on anyone, so a view only mounts this.
 */
import type { EntityId } from '@tm8/contract';
import { AttentionList, useAttentionOptional } from './index';
import './attention-surfaces.css';

export function AttentionQueueSection(props: {
  title: string;
  onOpen(rootId: EntityId): void;
  className?: string;
  testId?: string;
}) {
  const api = useAttentionOptional();
  if (!api || api.counts().all === 0) return null;
  return (
    <section
      className={['att-queue-section', props.className].filter(Boolean).join(' ')}
      aria-label={props.title}
      data-testid={props.testId}
    >
      <AttentionList title={props.title} onOpen={props.onOpen} />
    </section>
  );
}
