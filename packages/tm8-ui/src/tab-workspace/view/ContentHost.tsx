/**
 * Content host (Spec A §8, §13, §15): mounts ONLY the active tab's body —
 * entity body with trail, floating group and chat; draft host; chooser — or
 * the start surface. Workstream E.
 */
import { DraftHost } from '../adapters/draft';
import { EntityTabBody } from '../adapters/entity';
import { getKindAdapter } from '../adapters/registry';
import { activeTab } from '../runtime/selectors';
import { ChatDock } from './ChatDock';
import { Chooser } from './Chooser';
import { useWorkspaceState } from './context';
import { FloatingGroup } from './FloatingGroup';
import { LinkedTrail } from './LinkedTrail';
import { StartSurface } from './StartSurface';

export function ContentHost() {
  const tab = useWorkspaceState(activeTab);
  return (
    <main className="tws-content" data-testid="tws-content">
      {!tab ? (
        <StartSurface />
      ) : tab.type === 'chooser' ? (
        <Chooser key={tab.id} tabId={tab.id} variant="tab" />
      ) : tab.type === 'draft' ? (
        <DraftHost key={tab.id} tab={tab} />
      ) : (
        <div key={tab.id} className="tws-entity">
          <LinkedTrail tab={tab} />
          <div className="tws-entity-row">
            <div className="tws-entity-main">
              <FloatingGroup tab={tab} />
              <EntityTabBody tab={tab} adapter={getKindAdapter(tab.kind)} />
            </div>
            <ChatDock tab={tab} />
          </div>
        </div>
      )}
    </main>
  );
}
