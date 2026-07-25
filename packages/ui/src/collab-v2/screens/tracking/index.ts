/**
 * Tracking screen barrel (L5). `trackingViews` is the ViewRegistry fragment
 * Atlas merges into ShellLayout's `views` prop.
 */
import './tracking.css';

import type { ViewRegistry } from '../../shell';
import { TrackingScreen } from './TrackingScreen';

export { TrackingScreen } from './TrackingScreen';
export { TrackingRow, type TrackingRowProps } from './TrackingRow';
export { counterparts, TRACKS_EDGE } from './links';

/** ViewRegistry fragment: the `tracking` center view. */
export const trackingViews: ViewRegistry = { tracking: TrackingScreen };
