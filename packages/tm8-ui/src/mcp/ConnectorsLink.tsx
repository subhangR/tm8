import type { ReactNode } from 'react';
import { navStore } from '../stores/navStore';
export function ConnectorsLink({ children }: { children: ReactNode }) {
  const { spaceId } = navStore.getState();
  return <a href={`#/s/${encodeURIComponent(spaceId)}/settings/connectors`} onClick={event => {
    if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    event.preventDefault();
    navStore.getState().navigate({ view: 'settings', section: 'connectors' });
  }}>{children}</a>;
}
