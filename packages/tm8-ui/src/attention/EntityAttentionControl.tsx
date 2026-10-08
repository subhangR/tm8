import { useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useAnchoredPopover } from '../kit/anchoredPopover';
import { useOverlayHost } from '../kit/useOverlayHost';
import { useDismissable } from '../panels/useDismissable';
import { AttentionBlock } from './AttentionBlock';
import { useAttentionOptional } from './attention-store';
import './entity-attention-control.css';

/** Session attention lives in the right strip. Include both requests pinned
 * here and requests this session raised elsewhere. Group by the actual root
 * so each existing Resolve all control explains and settles its full scope. */
export function EntityAttentionControl({ entityId, onOpenEntity }: {
  entityId: string;
  onOpenEntity?: (id: string) => void;
}) {
  const api = useAttentionOptional();
  const rows = api?.queue('all').filter(row =>
    row.rootId === entityId || row.requests.some(request =>
      request.entityId === entityId || request.sourceWorkSessionId === entityId),
  ) ?? [];
  const count = rows.reduce((sum, row) => sum + row.requests.length, 0);
  const [open, setOpen] = useState(false);
  const trigger = useRef<HTMLButtonElement>(null);
  const pop = useRef<HTMLDivElement>(null);
  const { marker, host } = useOverlayHost();
  const dismiss = useCallback(() => {
    setOpen(false);
    trigger.current?.focus();
  }, []);
  useDismissable(open, [trigger, pop], dismiss);
  const style = useAnchoredPopover(open, () => trigger.current?.getBoundingClientRect(), pop,
    { side: 'left', align: 'start', gap: 14 });
  useEffect(() => {
    if (open) pop.current?.focus();
  }, [open]);
  useEffect(() => {
    if (count === 0) setOpen(false);
  }, [count]);

  return <>
    <span ref={marker} hidden />
    {count > 0 ? <button
      ref={trigger}
      type="button"
      className="att-entity-trigger"
      aria-label={`Attention: ${count} pending ${count === 1 ? 'request' : 'requests'}`}
      title={`Attention: ${count} pending ${count === 1 ? 'request' : 'requests'}`}
      aria-haspopup="dialog"
      aria-expanded={open}
      data-testid="entity-attention-control"
      onClick={() => setOpen(was => !was)}
    ><span aria-hidden="true">!</span><span className="att-entity-count">{count}</span></button> : null}
    {open && count > 0 && host ? createPortal(
      <div ref={pop} role="dialog" aria-label="Session attention" tabIndex={-1}
        className="att-entity-pop" style={style} data-testid="entity-attention-popover">
        <header className="att-entity-head">
          <strong>Attention · {count}</strong>
          <button type="button" className="att-btn" onClick={dismiss} aria-label="Close attention">×</button>
        </header>
        {rows.map(row => <div key={row.rootId} data-attention-root={row.rootId}>
          <div className="att-entity-root">{row.title ?? row.rootId}</div>
          <AttentionBlock entityId={row.rootId} noun={row.kind ?? 'entity'}
            defaultCollapsed={false} onOpenEntity={onOpenEntity} />
        </div>)}
      </div>, host,
    ) : null}
  </>;
}
