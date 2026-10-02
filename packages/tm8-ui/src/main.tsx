import React from 'react';
import { createRoot } from 'react-dom/client';
import './styles/tokens.css';
import './styles/canvas-extra.css';
import './styles/app.css';
import './kit/kit.css';
import './shell/shell.css';
import './panels/panels.css';
import './terminal/terminal.css';
import './shell/palette.css';
import './graph/graph.css';
import './servers/server.css';
import './transfer/transfer.css';
import './join/join.css';
import { installActiveStyle } from './theme/style-store';
import { App } from './App';
import { registerServiceWorker } from './pwa/register';

/*
 * THE TOKEN SHEET GOES IN BEFORE THE FIRST RENDER, not in an effect.
 *
 * `installActiveStyle()` writes `<style id="tm8-style-active">` into head with
 * the full resolved token table (design §3.1, §5 boot order step 1). It is
 * called below `createRoot`'s import and ABOVE the render for one reason: the
 * alternative is a first paint from `tokens.css`'s light block followed by a
 * flip, which is the exact flash the old `useTheme` initialiser existed to
 * avoid, moved one layer down.
 *
 * ORDER AGAINST THE STYLESHEETS IS LOAD-BEARING AND IS NOT THIS LINE'S JOB.
 * The sheet wins over `tokens.css` by arriving later in head at equal
 * specificity; the CSS imports above are evaluated first (dev) or emitted as a
 * <link> (build), and this element is appended at runtime, so it is always
 * last. The specificity argument itself is in `styleSheetText`.
 */
installActiveStyle();

createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);

// Prod builds only, and only on a secure origin — see src/pwa/register.ts.
registerServiceWorker();
