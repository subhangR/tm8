import type { ReactNode } from 'react';
import { navStore } from '../stores/navStore';
/** `label` names the link when its children are not words (a chip's logo, name and state). */
export function ConnectorsLink({ children, label, title }: { children: ReactNode; label?: string; title?: string }) {
  const { spaceId } = navStore.getState();
  return <a href={`#/s/${encodeURIComponent(spaceId)}/settings/connectors`} aria-label={label} title={title} onClick={event => {
    if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    event.preventDefault();
    navStore.getState().navigate({ view: 'settings', section: 'connectors' });
  }}>{children}</a>;
}
