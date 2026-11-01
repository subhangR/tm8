import { useEffect, useRef, type ReactNode } from 'react';

/** Native modal supplies focus containment, Escape and focus restoration. */
export function AppDetail({ label, view, onClose, children }: { label: string; view?: string; onClose(): void; children: ReactNode }) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    if (typeof dialog.showModal === 'function') dialog.showModal();
    else dialog.setAttribute('open', '');
    return () => { if (typeof dialog.close === 'function') dialog.close(); };
  }, []);
  return <dialog ref={ref} data-view={view} className="mcp-drawer connect-apps__dialog" aria-label={label} onCancel={event => { event.preventDefault(); onClose(); }}>
    {children}
  </dialog>;
}
