import type { ReactNode } from 'react';

export interface LinkRefusalCardProps {
  testId: string;
  title: string;
  children: ReactNode;
  actionLabel?: string;
  onAction?: () => void;
}

/** A standalone, honest answer for a shared link the client cannot open. */
export function LinkRefusalCard({
  testId,
  title,
  children,
  actionLabel = 'Open an available Space',
  onAction,
}: LinkRefusalCardProps) {
  return (
    <div className="shell-boot" role="alert" data-testid={testId}>
      <strong>{title}</strong>
      {children}
      {onAction ? (
        <button type="button" className="gov-btn gov-btn--ink" onClick={onAction}>
          {actionLabel}
        </button>
      ) : null}
    </div>
  );
}
