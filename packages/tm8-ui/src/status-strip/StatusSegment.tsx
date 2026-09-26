import type { ReactNode } from 'react';

import type { Tone } from './format';

export interface StatusSegmentProps {
  label: string;
  value: ReactNode;
  /** Tooltip: the full measurement behind the compact value. */
  title?: string;
  tone?: Tone;
  /** Renders a button when set; a plain span otherwise. */
  onClick?: () => void;
  testId?: string;
}

/**
 * One cell of the status strip: a quiet label and a tabular value. The
 * `status-strip__segment` class is the strip's styling contract, so a segment
 * built elsewhere (the attention lane's) can carry it without importing this.
 */
export function StatusSegment({ label, value, title, tone = 'normal', onClick, testId }: StatusSegmentProps) {
  const className = `status-strip__segment status-strip__segment--${tone}`;
  const body = (
    <>
      <span className="status-strip__label">{label}</span>
      <span className="status-strip__value">{value}</span>
    </>
  );
  if (onClick) {
    return (
      <button type="button" className={className} title={title} onClick={onClick} data-testid={testId}>
        {body}
      </button>
    );
  }
  return (
    <span className={className} title={title} data-testid={testId}>
      {body}
    </span>
  );
}
