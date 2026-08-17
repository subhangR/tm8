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
import { App } from './App';
import { registerServiceWorker } from './pwa/register';

createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);

// Prod builds only, and only on a secure origin — see src/pwa/register.ts.
registerServiceWorker();
