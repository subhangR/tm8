/** `workspace.browser.set` — patches the browser only; never touches tabs or scope. */
import { isWorkspaceKind } from '../types';
import type { BrowserKindState, BrowserState } from '../types';
import { isFiniteNumber, isRecord, reject, type Planner } from './shared';

export const EMPTY_BROWSER_KIND_STATE: BrowserKindState = { query: '', filters: null, scrollTop: 0 };

export const setBrowser: Planner = ({ state, env }) => {
  const args = env.args;
  if (!isRecord(args) || args.browserId !== 'main') return reject('invalid_arguments');
  if (args.kind !== undefined && !isWorkspaceKind(args.kind)) {
    return reject(typeof args.kind === 'string' ? 'unsupported_kind' : 'invalid_arguments');
  }
  if (args.query !== undefined && typeof args.query !== 'string') return reject('invalid_arguments');
  if (args.scrollTop !== undefined && !isFiniteNumber(args.scrollTop)) return reject('invalid_arguments');

  const prev = state.browsers.main;
  // Changing kind restores that kind's own query, filters and scroll.
  const kind = (args.kind as string | undefined) ?? prev.kind;
  const current = prev.perKind[kind] ?? EMPTY_BROWSER_KIND_STATE;
  const nextKindState: BrowserKindState = {
    query: args.query !== undefined ? (args.query as string) : current.query,
    filters: 'filters' in args ? args.filters : current.filters,
    scrollTop: args.scrollTop !== undefined ? (args.scrollTop as number) : current.scrollTop,
  };
  const kindChanged = kind !== prev.kind;
  const stateChanged =
    !(kind in prev.perKind) ||
    nextKindState.query !== current.query ||
    nextKindState.filters !== current.filters ||
    nextKindState.scrollTop !== current.scrollTop;
  if (!kindChanged && !stateChanged) return { type: 'commit', next: state };
  const main: BrowserState = { kind, perKind: { ...prev.perKind, [kind]: nextKindState } };
  const scrollOnly =
    !kindChanged && nextKindState.query === current.query && nextKindState.filters === current.filters;
  return { type: 'commit', next: { ...state, browsers: { main } }, significant: !scrollOnly };
};
