/**
 * Scratch harness for the craft canvas's EDGE DETAIL (task 01a181e0): the
 * blueprint canvas over the dense fixture craft, one level per page —
 * `?detail=all|reduced|essential`. The before/after screenshots come from here.
 */
import React from 'react';
import { createRoot } from 'react-dom/client';
import './styles/tokens.css';
import './styles/app.css';
import './kit/kit.css';
import { blueprintView } from './craft/blueprint-model';
import type { BlueprintEdgeDetail } from './craft/blueprint-types';
import { BlueprintCanvas } from './craft/BlueprintCanvas';
import { DENSE_CRAFT } from './craft/dense-craft.fixture';

const detail = (new URLSearchParams(location.search).get('detail') ?? 'all') as BlueprintEdgeDetail;
const view = blueprintView(DENSE_CRAFT, undefined, { edgeDetail: detail });

function Harness() {
  const [selected, setSelected] = React.useState<string | null>(null);
  return (
    <div className="cv2-root" style={{ width: '100%', height: '100%', display: 'flex' }}>
      <BlueprintCanvas view={view} ariaLabel="Dense craft" selectedKey={selected} onSelect={setSelected} />
    </div>
  );
}

createRoot(document.getElementById('root')!).render(<Harness />);
