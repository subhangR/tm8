/**
 * The attention queue as a page section — Home's NEEDS YOU and the workspace
 * empty centre's "Needs attention" (chapter 4 tab 8). Both are the same list
 * with the same rows and order as the top-bar popover, hidden when nothing is
 * waiting on anyone, so a view only mounts this.
 *
 * `filter="mine"` (Home) mounts only when something is the viewer's own and
 * starts on Personal; Team is a click away there and in the top bar.
 */
import type { EntityId } from '@tm8/contract';
import { AttentionList, useAttentionOptional } from './index';
import type { AttentionFilter, AttentionQueueRow } from './attention-selectors';
import './attention-surfaces.css';

export function AttentionQueueSection(props: {
  title: string;
  onOpen(targetId: EntityId, row: AttentionQueueRow): void;
  filter?: AttentionFilter;
  className?: string;
  testId?: string;
}) {
  const api = useAttentionOptional();
  if (!api) return null;
  const counts = api.counts();
  if ((props.filter === 'mine' ? counts.mine : counts.all) === 0) return null;
  return (
    <section
      className={['att-queue-section', props.className].filter(Boolean).join(' ')}
      aria-label={props.title}
      data-testid={props.testId}
    >
      <AttentionList title={props.title} filter={props.filter} onOpen={props.onOpen} />
    </section>
  );
}
