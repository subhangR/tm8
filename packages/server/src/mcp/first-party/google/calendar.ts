import { z } from 'zod';
import { segment, tool, type GoogleTool } from './api.js';

/** Google Calendar (§8.2): calendars, events, and free time across calendars. */

interface EventTime { dateTime?: string; date?: string; timeZone?: string }
interface Event {
  id: string; status?: string; summary?: string; description?: string; location?: string; htmlLink?: string;
  start?: EventTime; end?: EventTime; attendees?: { email?: string; responseStatus?: string }[]; organizer?: { email?: string };
}

function event(value: Event) {
  return {
    id: value.id, status: value.status, summary: value.summary, description: value.description, location: value.location,
    start: value.start, end: value.end, htmlLink: value.htmlLink, organizer: value.organizer?.email,
    attendees: value.attendees?.map(attendee => ({ email: attendee.email, responseStatus: attendee.responseStatus })),
  };
}

const CalendarId = z.string().min(1).max(500).optional().describe('Calendar id; "primary" (the default) is the account\'s own calendar.');
const EventId = z.string().min(1).max(1024);
const Instant = z.string().min(10).max(64).refine(value => !Number.isNaN(Date.parse(value)), 'must be an RFC 3339 date-time');
/** A whole day ("2026-10-21") or a moment ("2026-10-21T09:00:00+02:00"). */
const When = z.string().min(10).max(64).describe('RFC 3339 date-time, or a date (YYYY-MM-DD) for an all-day event.');

function time(value: string, timeZone?: string): EventTime {
  return /^\d{4}-\d{2}-\d{2}$/.test(value) ? { date: value } : { dateTime: value, ...(timeZone ? { timeZone } : {}) };
}

const EventFields = {
  summary: z.string().min(1).max(1024).describe('Title.'),
  start: When,
  end: When,
  timeZone: z.string().min(1).max(100).optional().describe('IANA time zone for start and end, e.g. "Europe/Berlin".'),
  description: z.string().max(8000).optional(),
  location: z.string().max(1024).optional(),
  attendees: z.array(z.string().min(3).max(320)).max(100).optional().describe('Attendee email addresses.'),
};

/** The free gaps of [from, to) once every busy block is removed, at least `minutes` long. */
export function freeSlots(from: number, to: number, busy: { start: string; end: string }[], minutes: number): { start: string; end: string }[] {
  const blocks = busy.map(block => [Date.parse(block.start), Date.parse(block.end)] as const)
    .filter(([start, end]) => !Number.isNaN(start) && !Number.isNaN(end) && end > start)
    .sort((a, b) => a[0] - b[0]);
  const free: { start: string; end: string }[] = [];
  let cursor = from;
  const keep = (start: number, end: number) => { if (end - start >= minutes * 60_000) free.push({ start: new Date(start).toISOString(), end: new Date(end).toISOString() }); };
  for (const [start, end] of blocks) {
    if (start > cursor) keep(cursor, Math.min(start, to));
    cursor = Math.max(cursor, end);
    if (cursor >= to) break;
  }
  if (cursor < to) keep(cursor, to);
  return free;
}

/** Which granted scope lets each tool work. */
const READ = ['https://www.googleapis.com/auth/calendar.readonly'];
const READ_EVENTS = ['https://www.googleapis.com/auth/calendar.readonly', 'https://www.googleapis.com/auth/calendar.events'];
const WRITE = ['https://www.googleapis.com/auth/calendar.events'];

export const CALENDAR_TOOLS: readonly GoogleTool[] = [
  tool({
    name: 'list_calendars',
    scopes: READ,
    description: 'List the calendars this account can see, with their ids and access role.',
    input: z.object({}).strict(),
    async run(api) {
      const listed = await api.json<{ items?: { id: string; summary?: string; primary?: boolean; accessRole?: string; timeZone?: string }[] }>('GET', api.endpoints.calendar, '/users/me/calendarList');
      return { calendars: (listed.items ?? []).map(item => ({ id: item.id, summary: item.summary, primary: item.primary === true, accessRole: item.accessRole, timeZone: item.timeZone })) };
    },
  }),
  tool({
    name: 'list_events',
    scopes: READ_EVENTS,
    description: 'List events in a time range, expanded into single occurrences and ordered by start time.',
    input: z.object({
      calendarId: CalendarId,
      timeMin: Instant.optional().describe('Start of the range (RFC 3339). Defaults to now.'),
      timeMax: Instant.optional().describe('End of the range (RFC 3339).'),
      query: z.string().max(500).optional().describe('Free-text search over event fields.'),
      maxResults: z.number().int().min(1).max(100).optional().describe('At most this many events (default 25).'),
      pageToken: z.string().max(500).optional(),
    }).strict(),
    async run(api, input) {
      const listed = await api.json<{ items?: Event[]; nextPageToken?: string; timeZone?: string }>('GET', api.endpoints.calendar, `/calendars/${segment(input.calendarId ?? 'primary')}/events`, {
        query: { singleEvents: true, orderBy: 'startTime', timeMin: input.timeMin ?? new Date().toISOString(), timeMax: input.timeMax, q: input.query, maxResults: input.maxResults ?? 25, pageToken: input.pageToken },
      });
      return { timeZone: listed.timeZone, events: (listed.items ?? []).map(event), ...(listed.nextPageToken ? { nextPageToken: listed.nextPageToken } : {}) };
    },
  }),
  tool({
    name: 'get_event',
    scopes: READ_EVENTS,
    description: 'Read one event.',
    input: z.object({ calendarId: CalendarId, eventId: EventId }).strict(),
    async run(api, input) {
      return event(await api.json<Event>('GET', api.endpoints.calendar, `/calendars/${segment(input.calendarId ?? 'primary')}/events/${segment(input.eventId)}`));
    },
  }),
  tool({
    name: 'create_event',
    scopes: WRITE,
    description: 'Create an event. Attendees are added to the event but not emailed an invitation.',
    input: z.object({ calendarId: CalendarId, ...EventFields }).strict(),
    async run(api, input) {
      return event(await api.json<Event>('POST', api.endpoints.calendar, `/calendars/${segment(input.calendarId ?? 'primary')}/events`, {
        query: { sendUpdates: 'none' },
        body: {
          summary: input.summary, start: time(input.start, input.timeZone), end: time(input.end, input.timeZone),
          ...(input.description !== undefined ? { description: input.description } : {}),
          ...(input.location !== undefined ? { location: input.location } : {}),
          ...(input.attendees ? { attendees: input.attendees.map(email => ({ email })) } : {}),
        },
      }));
    },
  }),
  tool({
    name: 'update_event',
    scopes: WRITE,
    description: 'Change fields of an existing event. Only the fields given are changed; attendees, when given, replace the list.',
    input: z.object({
      calendarId: CalendarId, eventId: EventId,
      summary: EventFields.summary.optional(), start: When.optional(), end: When.optional(), timeZone: EventFields.timeZone,
      description: EventFields.description, location: EventFields.location, attendees: EventFields.attendees,
    }).strict(),
    async run(api, input) {
      const patch: Record<string, unknown> = {};
      if (input.summary !== undefined) patch.summary = input.summary;
      if (input.start !== undefined) patch.start = time(input.start, input.timeZone);
      if (input.end !== undefined) patch.end = time(input.end, input.timeZone);
      if (input.description !== undefined) patch.description = input.description;
      if (input.location !== undefined) patch.location = input.location;
      if (input.attendees !== undefined) patch.attendees = input.attendees.map(email => ({ email }));
      return event(await api.json<Event>('PATCH', api.endpoints.calendar, `/calendars/${segment(input.calendarId ?? 'primary')}/events/${segment(input.eventId)}`, {
        query: { sendUpdates: 'none' }, body: patch,
      }));
    },
  }),
  tool({
    name: 'find_free_time',
    scopes: READ,
    description: 'Find free slots of at least the given length between two times, across one or more calendars.',
    input: z.object({
      timeMin: Instant.describe('Start of the window (RFC 3339).'),
      timeMax: Instant.describe('End of the window (RFC 3339).'),
      calendarIds: z.array(z.string().min(1).max(500)).min(1).max(20).optional().describe('Calendars to check (default ["primary"]).'),
      durationMinutes: z.number().int().min(5).max(1440).optional().describe('Shortest useful slot (default 30).'),
    }).strict(),
    async run(api, input) {
      const from = Date.parse(input.timeMin); const to = Date.parse(input.timeMax);
      if (to <= from) return { busy: [], free: [] };
      const ids = input.calendarIds ?? ['primary'];
      const answer = await api.json<{ calendars?: Record<string, { busy?: { start: string; end: string }[]; errors?: unknown[] }> }>('POST', api.endpoints.calendar, '/freeBusy', {
        body: { timeMin: input.timeMin, timeMax: input.timeMax, items: ids.map(id => ({ id })) },
      });
      const busy = Object.values(answer.calendars ?? {}).flatMap(calendar => calendar.busy ?? []);
      const unavailable = Object.entries(answer.calendars ?? {}).filter(([, calendar]) => calendar.errors?.length).map(([id]) => id);
      return { busy, free: freeSlots(from, to, busy, input.durationMinutes ?? 30), ...(unavailable.length ? { unavailableCalendars: unavailable } : {}) };
    },
  }),
];
