/** Per-tab chat dock / overlay (Spec A §10). Workstream G. */
import type { EntityTabRecord } from '../runtime/types';

export interface ChatDockProps {
  tab: EntityTabRecord;
}

export function ChatDock({ tab }: ChatDockProps) {
  if (!tab.ui.chat?.open) return null;
  return <aside className="tws-chat" aria-label="Chat" data-testid="tws-chat" />;
}
