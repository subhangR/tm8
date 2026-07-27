import { GalleryPage } from './gallery/GalleryPage';

/**
 * A0 placeholder root: the dev-only kit gallery. The real shell (space tab
 * bar → menu rail → view host) replaces this in A1; the gallery then moves
 * behind a dev route.
 */
export function App() {
  return <GalleryPage />;
}
