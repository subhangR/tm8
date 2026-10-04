import { createRoot } from 'react-dom/client';
import './styles/tokens.css';
import './styles/canvas-extra.css';
import './styles/app.css';
import { AssetCatalog, CATALOG_SHEETS, type CatalogSheet } from './story/game/assets/AssetCatalog';

/**
 * STORY GAME ASSET CATALOG — no server, no fixtures, just the kit.
 * Usage: /asset-catalog-dev.html?sheet=types|states|containers|plot|kit|overview
 *        &theme=dark  &silhouette=1  &sockets=1  &reduced=1
 */
const params = new URLSearchParams(window.location.search);
const sheet = (CATALOG_SHEETS as readonly string[]).includes(params.get('sheet') ?? '') ? params.get('sheet') as CatalogSheet : 'types';
createRoot(document.getElementById('root')!).render(
  <AssetCatalog sheet={sheet} theme={params.get('theme') === 'dark' ? 'dark' : 'light'} silhouette={params.get('silhouette') === '1'} sockets={params.get('sockets') === '1'} reduced={params.get('reduced') === '1'} />,
);
