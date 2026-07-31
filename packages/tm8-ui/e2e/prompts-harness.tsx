import { createRoot } from 'react-dom/client';
import { PromptsScreen } from '../src/prompts';
import '../src/styles/tokens.css';
import '../src/styles/canvas-extra.css';
import '../src/styles/app.css';
import '../src/kit/kit.css';

/**
 * A DETERMINISTIC BROWSER HARNESS FOR THE PROMPT CATALOG.
 *
 * The vitest suite proves the screen shows the right BYTES; it structurally
 * cannot prove the screen is readable, because jsdom has no layout engine. The
 * specific risks here are all layout ones: three panes each need a floor, the
 * kernel prompt is ~2 KB of monospace that must wrap rather than force the page
 * to scroll sideways, and the whole thing has to survive the theme inversion.
 *
 * The catalog needs no seam and no server — it is static data compiled from the
 * composers — so this harness is the real screen with nothing stubbed at all.
 */
const root = document.getElementById('root')!;
createRoot(root).render(
  <div className="cv2-root" style={{ height: '100vh', display: 'flex' }}>
    <PromptsScreen />
  </div>,
);
