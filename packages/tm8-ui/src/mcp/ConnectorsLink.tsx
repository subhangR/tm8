import type { ReactNode } from 'react';
import { navStore } from '../stores/navStore';
/** `label` names the link when its children are not words (a chip's logo, name and state). */
/** `disabled` draws the same content inert: leaving now would unmount a launch in flight. */
export function ConnectorsLink({ children, label, title, disabled = false }: { children: ReactNode; label?: string; title?: string; disabled?: boolean }) {
  if (disabled) return <span aria-disabled="true" aria-label={label} title={title}>{children}</span>;
  const { spaceId } = navStore.getState();
  return <a href={`#/s/${encodeURIComponent(spaceId)}/settings/connectors`} aria-label={label} title={title} onClick={event => {
    if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    event.preventDefault();
    navStore.getState().navigate({ view: 'settings', section: 'connectors' });
  }}>{children}</a>;
}
