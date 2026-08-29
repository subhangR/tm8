/**
 * The dev review board's mount. Pairs with `board.html`; see that file for
 * why both live inside this lane.
 *
 * Renders BOTH themes stacked so a reviewer sees the pair in one scroll —
 * which is also the only way to check the T3-5 claim that the machine room is
 * graphite in both (oracle L237): a screen that looks right in dark and
 * inverts in light passes every assertion in the suite.
 */
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { FilesNodeBoard } from './index';

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <FilesNodeBoard theme="light" />
    <FilesNodeBoard theme="dark" />
  </StrictMode>,
);
