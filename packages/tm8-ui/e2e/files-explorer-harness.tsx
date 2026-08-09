import { useEffect, useMemo, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { createFixtureSeam } from '../src/data/fixtures/seam-fixture';
import { FilesExplorerScreen, filesExplorerPortFromSeam } from '../src/files-explorer';
import type { FilesExplorerPort } from '../src/files-explorer';
import '../src/styles/tokens.css';
import '../src/styles/canvas-extra.css';
import '../src/styles/app.css';
import '../src/kit/kit.css';

/**
 * DETERMINISTIC BROWSER HARNESS for the Files explorer — the layout half of
 * its verification. jsdom has no layout engine, so "the roots rail is a fixed
 * column and the listing takes the rest", "the breadcrumb bar does not wrap
 * the body out of view", and "the gallery grid actually forms columns" are
 * only checkable here. The vitest suite owns behaviour; this owns geometry.
 *
 * Mounts the REAL screen over the REAL port over a REAL fixture seam.
 */
function Harness() {
  const seam = useMemo(() => createFixtureSeam(), []);
  const [port, setPort] = useState<FilesExplorerPort | null>(null);

  useEffect(() => {
    void seam.spaces().then((spaces) => {
      const spaceId = spaces[0]!.id;
      void seam.openSpace(spaceId).then(() => {
        setPort(filesExplorerPortFromSeam(seam, spaceId));
      });
    });
  }, [seam]);

  if (!port) return <div data-testid="harness-booting">booting…</div>;
  return (
    <div
      className="cv2-root"
      data-testid="harness-ready"
      style={{ position: 'fixed', inset: 0, display: 'flex' }}
    >
      <FilesExplorerScreen port={port} />
    </div>
  );
}

createRoot(document.getElementById('root')!).render(<Harness />);
