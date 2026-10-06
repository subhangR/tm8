/** `workspace.layout.set` — bounded widths and the expanded flag. */
import { LAYOUT_BOUNDS } from '../types.js';
import { isFiniteNumber, isRecord, reject, type Planner } from './shared.js';

const clamp = (value: number, { min, max }: { min: number; max: number }) =>
  Math.round(Math.min(max, Math.max(min, value)));

export const setLayout: Planner = ({ state, env }) => {
  const args = env.args;
  if (!isRecord(args)) return reject('invalid_arguments');
  if (args.expanded !== undefined && typeof args.expanded !== 'boolean') return reject('invalid_arguments');
  if (args.browserWidth !== undefined && !isFiniteNumber(args.browserWidth)) return reject('invalid_arguments');
  if (args.chatWidth !== undefined && !isFiniteNumber(args.chatWidth)) return reject('invalid_arguments');
  const prev = state.layout;
  const layout = {
    expanded: (args.expanded as boolean | undefined) ?? prev.expanded,
    browserWidth:
      args.browserWidth !== undefined ? clamp(args.browserWidth as number, LAYOUT_BOUNDS.browserWidth) : prev.browserWidth,
    chatWidth: args.chatWidth !== undefined ? clamp(args.chatWidth as number, LAYOUT_BOUNDS.chatWidth) : prev.chatWidth,
  };
  const same =
    layout.expanded === prev.expanded && layout.browserWidth === prev.browserWidth && layout.chatWidth === prev.chatWidth;
  return { type: 'commit', next: same ? state : { ...state, layout } };
};
