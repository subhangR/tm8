/** `workspace.rail.set` (Spec D §1) — the icon rail's pins, open sections, expanded flag and lifted kinds. */
import type { RailPrefs } from '../types.js';
import { isRecord, reject, type Planner } from './shared.js';

const MAX_PINS = 32;
const MAX_SECTIONS = 64;

export const DEFAULT_RAIL: RailPrefs = { pins: ['chat', 'task', 'work_session'], open: {}, expanded: false };

export const setRail: Planner = ({ state, env }) => {
  const args = env.args;
  if (!isRecord(args)) return reject('invalid_arguments');
  const { pins, open, expanded, lifted } = args;
  const kindList = (v: unknown) =>
    Array.isArray(v) && v.length <= MAX_PINS && v.every((p) => typeof p === 'string' && p.length > 0 && p.length <= 64);
  if (pins !== undefined && !kindList(pins)) return reject('invalid_arguments');
  if (lifted !== undefined && !kindList(lifted)) return reject('invalid_arguments');
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
  const nextLifted = lifted !== undefined ? [...new Set(lifted as string[])] : prev.lifted;
  if (nextLifted !== undefined) rail.lifted = nextLifted;
  const same =
    state.rail !== undefined &&
    rail.expanded === prev.expanded &&
    rail.pins.join('\u0000') === prev.pins.join('\u0000') &&
    (rail.lifted ?? []).join('\u0000') === (prev.lifted ?? []).join('\u0000') &&
    JSON.stringify(rail.open) === JSON.stringify(prev.open);
  return { type: 'commit', next: same ? state : { ...state, rail } };
};
