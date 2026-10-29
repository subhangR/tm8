export { browserTimeZone } from '../kit/time';

/*
 * THE FORM'S SCHEDULE PRESETS — words ⇄ an expression, nothing more.
 *
 * A preset is a way to WRITE an expression in the server's grammar
 * (`every <n>{m|h|d}` or five-field cron); it never decides whether the
 * expression is valid, what it means, or when it next fires. Those answers
 * come from `loops.schedule.preview` (design 01a182d4 §3.1): the browser
 * grammar this replaced (`loops/schedule.ts`) is gone on purpose.
 *
 * `presetOf` reads an existing loop's expression back into a preset for the
 * edit form. Anything it does not recognise opens as Custom cron with the
 * expression untouched, so editing never rewrites a schedule the human did
 * not change.
 */

export type SchedulePresetKind = 'hourly' | 'daily' | 'weekdays' | 'weekly' | 'interval' | 'custom';
export type IntervalUnit = 'm' | 'h';

export interface SchedulePreset {
  kind: SchedulePresetKind;
  /** Minute past the hour (hourly) or of the time (daily/weekdays/weekly). */
  minute: number;
  /** Hour of day, 0–23 (daily/weekdays/weekly). */
  hour: number;
  /** Day of week, 0 = Sunday (weekly). */
  weekday: number;
  /** Interval count and unit (interval). NaN while the field is empty or not a whole number. */
  every: number;
  unit: IntervalUnit;
  /**
   * The custom expression as the human typed it (or a stored custom one).
   * Empty until then, so switching to Custom starts from what the current
   * preset writes, and a typed expression survives a round trip through
   * another preset.
   */
  cron: string;
}

export const PRESET_LABELS: readonly { id: SchedulePresetKind; label: string }[] = [
  { id: 'hourly', label: 'Hourly' },
  { id: 'daily', label: 'Daily at…' },
  { id: 'weekdays', label: 'Weekdays at…' },
  { id: 'weekly', label: 'Weekly on…' },
  { id: 'interval', label: 'Every N minutes / hours' },
  { id: 'custom', label: 'Custom cron' },
];

export const WEEKDAYS: readonly string[] = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

export const DEFAULT_PRESET: SchedulePreset = {
  kind: 'daily', minute: 0, hour: 9, weekday: 1, every: 15, unit: 'm', cron: '',
};

const wholeIn = (n: number, min: number, max: number) => Number.isInteger(n) && n >= min && n <= max;

/**
 * The expression a preset writes, or '' when a number field is empty or not
 * a whole number (nothing is clamped into a value the human did not type).
 * Custom passes the typed text through trimmed. Whether the expression is a
 * valid schedule is the server's answer, not this function's.
 */
export function expressionOf(preset: SchedulePreset): string {
  const { minute, hour } = preset;
  switch (preset.kind) {
    case 'hourly': return wholeIn(minute, 0, 59) ? `${minute} * * * *` : '';
    case 'daily': return `${minute} ${hour} * * *`;
    case 'weekdays': return `${minute} ${hour} * * 1-5`;
    case 'weekly': return `${minute} ${hour} * * ${preset.weekday}`;
    case 'interval': return Number.isInteger(preset.every) && preset.every >= 1 ? `every ${preset.every}${preset.unit}` : '';
    case 'custom': return preset.cron.trim();
  }
}

const INT = '(\\d{1,2})';
const HOURLY = new RegExp(`^${INT} \\* \\* \\* \\*$`);
const AT = new RegExp(`^${INT} ${INT} \\* \\* (\\*|1-5|[0-6])$`);
const EVERY = /^every (\d+)([mh])$/;

/** Why a preset writes no expression, in the words of the field that is missing. */
export function presetProblem(preset: SchedulePreset): string | null {
  if (expressionOf(preset) !== '') return null;
  if (preset.kind === 'interval') return 'Enter how often, as a whole number.';
  if (preset.kind === 'hourly') return 'Enter the minute past the hour, 0 to 59.';
  return 'Enter a cron expression.';
}

/** A whole number typed into a preset field, or NaN for an empty or partial one (so nothing snaps). */
export function wholeNumberOf(text: string): number {
  const trimmed = text.trim();
  return /^\d+$/.test(trimmed) ? Number(trimmed) : NaN;
}

/** The preset an expression was written by, or Custom with the expression as typed. */
export function presetOf(expression: string): SchedulePreset {
  const text = expression.trim().replace(/\s+/g, ' ');
  const base = { ...DEFAULT_PRESET };
  const every = EVERY.exec(text);
  if (every) return { ...base, kind: 'interval', every: Number(every[1]), unit: every[2] as IntervalUnit };
  const hourly = HOURLY.exec(text);
  if (hourly && Number(hourly[1]) <= 59) return { ...base, kind: 'hourly', minute: Number(hourly[1]) };
  const at = AT.exec(text);
  if (at && Number(at[1]) <= 59 && Number(at[2]) <= 23) {
    const minute = Number(at[1]);
    const hour = Number(at[2]);
    if (at[3] === '*') return { ...base, kind: 'daily', minute, hour };
    if (at[3] === '1-5') return { ...base, kind: 'weekdays', minute, hour };
    return { ...base, kind: 'weekly', minute, hour, weekday: Number(at[3]) };
  }
  return { ...base, kind: 'custom', cron: expression.trim() };
}

/** "09:05" for a time input. */
export function timeOf(preset: Pick<SchedulePreset, 'hour' | 'minute'>): string {
  return `${String(preset.hour).padStart(2, '0')}:${String(preset.minute).padStart(2, '0')}`;
}

/** A time input's "HH:MM" into hour and minute; an empty or partial value keeps the previous. */
export function parseTime(value: string, previous: Pick<SchedulePreset, 'hour' | 'minute'>): { hour: number; minute: number } {
  const match = /^(\d{1,2}):(\d{2})$/.exec(value);
  if (!match) return { hour: previous.hour, minute: previous.minute };
  return { hour: Math.min(23, Number(match[1])), minute: Math.min(59, Number(match[2])) };
}

/**
 * Zones to offer. The list is the runtime's; the server validates the pick
 * with the same `Intl.supportedValuesOf` (§3.1). `UTC` and the current value
 * are always present so an older runtime or a stored zone still shows.
 */
export function timeZoneOptions(current: string): string[] {
  const zones = supportedZones();
  return !current || zones.includes(current) ? zones : [...zones, current];
}

/** The runtime's zone list, read once: it does not change while the page lives. */
let zoneList: string[] | null = null;
function supportedZones(): string[] {
  if (zoneList) return zoneList;
  let zones: string[] = [];
  try {
    const supported = (Intl as unknown as { supportedValuesOf?: (key: string) => string[] }).supportedValuesOf;
    zones = supported ? supported('timeZone') : [];
  } catch {
    zones = [];
  }
  zoneList = [...new Set(['UTC', ...zones])];
  return zoneList;
}
