/** `workspace.rail.set` (Spec D §1) — the icon rail's pins, open sections and expanded flag. */
import type { RailPrefs } from '../types.js';
import { isRecord, reject, type Planner } from './shared.js';

const MAX_PINS = 32;
const MAX_SECTIONS = 64;

export const DEFAULT_RAIL: RailPrefs = { pins: ['chat', 'task', 'work_session'], open: {}, expanded: false };

export const setRail: Planner = ({ state, env }) => {
  const args = env.args;
  if (!isRecord(args)) return reject('invalid_arguments');
  const { pins, open, expanded } = args;
  if (pins !== undefined && (!Array.isArray(pins) || pins.length > MAX_PINS || pins.some((p) => typeof p !== 'string' || p.length === 0 || p.length > 64))) {
    return reject('invalid_arguments');
  }
  if (open !== undefined && (!isRecord(open) || Object.keys(open).length > MAX_SECTIONS || Object.values(open).some((v) => typeof v !== 'boolean'))) {
    return reject('invalid_arguments');
  }
  if (expanded !== undefined && typeof expanded !== 'boolean') return reject('invalid_arguments');
  const prev = state.rail ?? DEFAULT_RAIL;
  const rail: RailPrefs = {
    pins: pins !== undefined ? [...new Set(pins as string[])] : prev.pins,
    open: open !== undefined ? { ...prev.open, ...(open as Record<string, boolean>) } : prev.open,
    expanded: (expanded as boolean | undefined) ?? prev.expanded,
  };
  const same =
    state.rail !== undefined &&
    rail.expanded === prev.expanded &&
    rail.pins.join('\u0000') === prev.pins.join('\u0000') &&
    JSON.stringify(rail.open) === JSON.stringify(prev.open);
  return { type: 'commit', next: same ? state : { ...state, rail } };
};
