/** Standalone entry for collab-v2.html — never touches the live app shell. */
import React from 'react';
import ReactDOM from 'react-dom/client';
import CollabV2App from './CollabV2App';

ReactDOM.createRoot(document.getElementById('collab-v2-root') as HTMLElement).render(
  <React.StrictMode>
    <CollabV2App />
  </React.StrictMode>,
);
