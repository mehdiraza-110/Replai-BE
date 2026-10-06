const crypto = require("crypto");
const db = require("../config/db.config");
const googleCalendarService = require("./googleCalendar.service");

const FREE_BUSY_URL = "https://www.googleapis.com/calendar/v3/freeBusy";
const CALENDAR_EVENTS_URL = "https://www.googleapis.com/calendar/v3/calendars";

const LOOKAHEAD_BUSINESS_DAYS = 5;
const MAX_CALENDAR_DAYS_SCANNED = 14;
const DEFAULT_DURATION_MINUTES = 30;
const DEFAULT_OFFER_COUNT = 3;
const SLOT_GRID_MS = 30 * 60 * 1000;
const DEFAULT_WORKING_HOURS_START = "09:00";
const DEFAULT_WORKING_HOURS_END = "17:00";
const DEFAULT_TIMEZONE = "UTC";
// Never propose a slot that starts in the next few minutes — the lead needs
// time to actually read the reply.
const MIN_LEAD_TIME_MS = 30 * 60 * 1000;

class MeetingBookingService {
  /**
   * Proposes up to `count` free `meeting_duration_minutes` windows inside the
   * agent's working hours over the next 5 business days, spread across days and
   * skipping any start time in `excludeStarts` (slots offered earlier).
   * Returns [{ startTime, endTime }] as ISO strings; empty when nothing fits.
   */
  async findFreeSlots(agent, connection, { count = DEFAULT_OFFER_COUNT, excludeStarts = [] } = {}) {
    if (!connection) return [];

    const settings = resolveAgentSettings(agent);
    const windows = buildWorkingWindows(new Date(), settings);
    if (windows.length === 0) return [];

    const busy = await this.fetchBusy(connection, windows[0].start, windows[windows.length - 1].end, settings.timezone);
    const excluded = new Set(excludeStarts.map((value) => new Date(value).getTime()));
    const days = candidateSlotsByDay(windows, busy, settings.durationMinutes * 60 * 1000, excluded);

    return pickSpreadSlots(days, count).map((slot) => ({
      startTime: new Date(slot.start).toISOString(),
      endTime: new Date(slot.end).toISOString(),
    }));
  }

  /** True when nothing on the calendar overlaps `slot` and it is still in the future. */
  async isSlotFree(agent, connection, slot) {
    const start = new Date(slot?.startTime).getTime();
    const end = new Date(slot?.endTime).getTime();
    if (!connection || !Number.isFinite(start) || !Number.isFinite(end) || start <= Date.now()) return false;

    const { timezone } = resolveAgentSettings(agent);
    const busy = await this.fetchBusy(connection, start, end, timezone);

    return !busy.some((interval) => interval.start < end && interval.end > start);
  }

  async fetchBusy(connection, timeMin, timeMax, timeZone) {
    const accessToken = await googleCalendarService.getValidAccessToken(connection);
    const calendarId = connection.calendar_id || "primary";

    const response = await fetch(FREE_BUSY_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        timeMin: new Date(timeMin).toISOString(),
        timeMax: new Date(timeMax).toISOString(),
        timeZone,
        items: [{ id: calendarId }],
      }),
    });
    const payload = await response.json().catch(() => ({}));

    if (!response.ok) {
      const error = new Error(payload?.error?.message || `Google freeBusy request failed with ${response.status}`);
      error.statusCode = response.status;
      throw error;
    }

    const calendarBusy = payload?.calendars?.[calendarId]?.busy;
    return normalizeBusyIntervals(
      Array.isArray(calendarBusy)
        ? calendarBusy
        : Object.values(payload?.calendars || {}).flatMap((entry) => entry?.busy || [])
    );
  }

  /** The offer awaiting the lead's answer on this thread, or null. */
  async getActiveOffer(threadId) {
    if (!threadId) return null;

    const result = await db.query(
      `SELECT * FROM meeting_slot_offers
       WHERE thread_id = $1 AND status = 'offered'
       ORDER BY created_at DESC
       LIMIT 1`,
      [threadId]
    );

    return result.rows[0] || null;
  }

  /** Records a new offer, superseding any outstanding one on the thread. */
  async createOffer({ agentId, threadId, leadEmail, slots }) {
    await db.query(
      `UPDATE meeting_slot_offers SET status = 'superseded', updated_at = NOW()
       WHERE thread_id = $1 AND status = 'offered'`,
      [threadId]
    );
    const result = await db.query(
      `INSERT INTO meeting_slot_offers (ai_agent_id, thread_id, lead_email, slots)
       VALUES ($1, $2, $3, $4)
       RETURNING *`,
      [agentId, threadId, leadEmail || null, JSON.stringify(slots)]
    );

    return result.rows[0];
  }

  async markOfferAccepted(offerId) {
    await db.query(`UPDATE meeting_slot_offers SET status = 'accepted', updated_at = NOW() WHERE id = $1`, [offerId]);
  }

  /** Starts of every slot already proposed on the thread, so new offers differ. */
  async getOfferedStarts(threadId) {
    const result = await db.query(`SELECT slots FROM meeting_slot_offers WHERE thread_id = $1`, [threadId]);
    return result.rows.flatMap((row) => (row.slots || []).map((slot) => slot.startTime));
  }

  async hasBooking(threadId) {
    if (!threadId) return false;

    const result = await db.query(
      `SELECT 1 FROM meeting_bookings WHERE thread_id = $1 AND status = 'booked' LIMIT 1`,
      [threadId]
    );

    return result.rowCount > 0;
  }

  /**
   * Books `slot` on the connected calendar with a Google Meet link and the lead
   * as an attendee. Never throws: "no slot could be booked" is an expected
   * outcome that the reply pipeline handles with its fallback-link path.
   */
  async bookSlot(agent, connection, slot, leadEmail, leadName) {
    if (!connection || !slot?.startTime || !slot?.endTime) return { success: false };

    const settings = resolveAgentSettings(agent);
    const calendarId = connection.calendar_id || "primary";

    try {
      const accessToken = await googleCalendarService.getValidAccessToken(connection);
      const attendees = leadEmail
        ? [{ email: leadEmail, ...(leadName ? { displayName: leadName } : {}) }]
        : [];

      const response = await fetch(
        `${CALENDAR_EVENTS_URL}/${encodeURIComponent(calendarId)}/events?conferenceDataVersion=1&sendUpdates=all`,
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${accessToken}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            summary: buildSummary(agent, leadName, leadEmail),
            description: buildDescription(agent),
            start: { dateTime: slot.startTime, timeZone: settings.timezone },
            end: { dateTime: slot.endTime, timeZone: settings.timezone },
            attendees,
            conferenceData: {
              createRequest: {
                requestId: crypto.randomUUID(),
                conferenceSolutionKey: { type: "hangoutsMeet" },
              },
            },
          }),
        }
      );
      const payload = await response.json().catch(() => ({}));

      if (!response.ok) {
        throw new Error(payload?.error?.message || `Google event creation failed with ${response.status}`);
      }

      const meetLink = extractMeetLink(payload);

      await db.query(
        `INSERT INTO meeting_bookings (
          ai_agent_id,
          thread_id,
          lead_email,
          google_event_id,
          meet_link,
          scheduled_start,
          scheduled_end,
          status
        )
        VALUES ($1, $2, $3, $4, $5, $6, $7, 'booked')`,
        [
          connection.ai_agent_id,
          slot.threadId || null,
          leadEmail || null,
          payload.id || null,
          meetLink,
          slot.startTime,
          slot.endTime,
        ]
      );

      return {
        success: true,
        meetLink,
        eventId: payload.id || null,
        startTime: slot.startTime,
        endTime: slot.endTime,
      };
    } catch (error) {
      console.warn("Meeting booking failed, falling back to the agent's meeting link:", error.message);
      return { success: false };
    }
  }
}

/* -------------------------------------------------------------------------- */
/* Pure scheduling helpers                                                    */
/* -------------------------------------------------------------------------- */

function resolveAgentSettings(agent = {}) {
  const timezone = normalizeTimezone(
    agent.agent_timezone ?? agent.timezone ?? DEFAULT_TIMEZONE
  );
  const durationMinutes = normalizeDuration(
    agent.agent_meeting_duration_minutes ?? agent.meeting_duration_minutes
  );
  const workStart = parseTimeOfDay(
    agent.agent_working_hours_start ?? agent.working_hours_start,
    DEFAULT_WORKING_HOURS_START
  );
  const workEnd = parseTimeOfDay(
    agent.agent_working_hours_end ?? agent.working_hours_end,
    DEFAULT_WORKING_HOURS_END
  );

  return { timezone, durationMinutes, workStart, workEnd };
}

function normalizeTimezone(value) {
  const text = value ? String(value).trim() : "";
  if (!text) return DEFAULT_TIMEZONE;

  try {
    new Intl.DateTimeFormat("en-US", { timeZone: text });
    return text;
  } catch {
    console.warn(`Unknown agent timezone "${text}", falling back to ${DEFAULT_TIMEZONE}`);
    return DEFAULT_TIMEZONE;
  }
}

function normalizeDuration(value) {
  const minutes = Number(value);
  if (!Number.isFinite(minutes) || minutes <= 0) return DEFAULT_DURATION_MINUTES;
  return Math.min(Math.round(minutes), 8 * 60);
}

// Postgres TIME columns arrive from `pg` as "09:00:00"; tolerate "9:00" too.
function parseTimeOfDay(value, fallback) {
  return readTimeOfDay(value) || readTimeOfDay(fallback) || { hour: 9, minute: 0 };
}

function readTimeOfDay(value) {
  const text = value === undefined || value === null ? "" : String(value).trim();
  const match = text.match(/^(\d{1,2}):(\d{2})(?::\d{2})?/);
  if (!match) return null;

  const hour = Number(match[1]);
  const minute = Number(match[2]);

  if (hour < 0 || hour > 23 || minute < 0 || minute > 59) return null;

  return { hour, minute };
}

/**
 * The offset (ms) of `timeZone` at the instant `date`, i.e. localWallClock - UTC.
 */
function timezoneOffsetMs(date, timeZone) {
  const formatter = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
  const parts = Object.fromEntries(
    formatter.formatToParts(date).filter((part) => part.type !== "literal").map((part) => [part.type, Number(part.value)])
  );
  const asUtc = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second);

  return asUtc - date.getTime();
}

/**
 * Converts a wall-clock time in `timeZone` into a UTC timestamp (ms). The second
 * pass handles DST transitions, where the offset at the naive guess differs from
 * the offset at the real instant.
 */
function zonedWallClockToUtc({ year, month, day, hour, minute }, timeZone) {
  const naive = Date.UTC(year, month - 1, day, hour, minute, 0, 0);
  const firstOffset = timezoneOffsetMs(new Date(naive), timeZone);
  const firstGuess = naive - firstOffset;
  const secondOffset = timezoneOffsetMs(new Date(firstGuess), timeZone);

  return secondOffset === firstOffset ? firstGuess : naive - secondOffset;
}

/** The calendar date (in `timeZone`) that the instant `date` falls on. */
function zonedCalendarDate(date, timeZone) {
  const formatter = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });
  const parts = Object.fromEntries(
    formatter.formatToParts(date).filter((part) => part.type !== "literal").map((part) => [part.type, Number(part.value)])
  );

  return { year: parts.year, month: parts.month, day: parts.day };
}

/**
 * Working-hour windows (UTC ms) for the next `LOOKAHEAD_BUSINESS_DAYS` business
 * days, starting from `now`, skipping weekends and any window already in the past.
 */
function buildWorkingWindows(now, settings) {
  const { timezone, workStart, workEnd } = settings;
  const today = zonedCalendarDate(now, timezone);
  const earliest = now.getTime() + MIN_LEAD_TIME_MS;
  const windows = [];

  for (let offset = 0; offset < MAX_CALENDAR_DAYS_SCANNED && windows.length < LOOKAHEAD_BUSINESS_DAYS; offset += 1) {
    // Nominal-UTC arithmetic purely for calendar rollover; never used as an instant.
    const nominal = new Date(Date.UTC(today.year, today.month - 1, today.day + offset));
    const weekday = nominal.getUTCDay();

    if (weekday === 0 || weekday === 6) continue;

    const date = {
      year: nominal.getUTCFullYear(),
      month: nominal.getUTCMonth() + 1,
      day: nominal.getUTCDate(),
    };
    const dayStart = zonedWallClockToUtc({ ...date, hour: workStart.hour, minute: workStart.minute }, timezone);
    const dayEnd = zonedWallClockToUtc({ ...date, hour: workEnd.hour, minute: workEnd.minute }, timezone);

    if (dayEnd <= dayStart) continue;

    // A business day counts as looked at even when today's remaining hours are
    // too short — otherwise a late-afternoon reply would scan 6 days.
    // Today counts as one of the business days even if only part of it is left;
    // fully-past days are dropped by the filter below.
    windows.push({ start: Math.max(dayStart, earliest), end: dayEnd });
  }

  return windows.filter((window) => window.end > window.start);
}

function normalizeBusyIntervals(busy) {
  return (busy || [])
    .map((interval) => ({
      start: new Date(interval.start).getTime(),
      end: new Date(interval.end).getTime(),
    }))
    .filter((interval) => Number.isFinite(interval.start) && Number.isFinite(interval.end) && interval.end > interval.start)
    .sort((a, b) => a.start - b.start);
}

/**
 * Walks each working window, subtracting the busy intervals that overlap it, and
 * returns the first remaining gap at least `durationMs` long.
 */
function firstFreeSlot(windows, busy, durationMs) {
  for (const window of windows) {
    let cursor = window.start;

    for (const interval of busy) {
      if (interval.end <= cursor) continue;
      if (interval.start >= window.end) break;

      if (interval.start - cursor >= durationMs) {
        return { start: cursor, end: cursor + durationMs };
      }

      cursor = Math.max(cursor, interval.end);
      if (cursor >= window.end) break;
    }

    if (window.end - cursor >= durationMs) {
      return { start: cursor, end: cursor + durationMs };
    }
  }

  return null;
}

/**
 * Free, grid-aligned slots per working window (one list per day that has any),
 * skipping starts in `excluded`.
 */
function candidateSlotsByDay(windows, busy, durationMs, excluded = new Set()) {
  const step = Math.max(durationMs, SLOT_GRID_MS);

  return windows
    .map((window) => {
      const slots = [];

      for (let start = Math.ceil(window.start / SLOT_GRID_MS) * SLOT_GRID_MS; start + durationMs <= window.end; start += step) {
        const end = start + durationMs;
        if (excluded.has(start)) continue;
        if (busy.some((interval) => interval.start < end && interval.end > start)) continue;
        slots.push({ start, end });
      }

      return slots;
    })
    .filter((slots) => slots.length > 0);
}

/**
 * Picks up to `count` slots, one per day first (alternating an early and a later
 * time of day), then more from the same days if there are fewer days than slots.
 */
function pickSpreadSlots(days, count) {
  const picked = [];
  const used = days.map(() => new Set());

  while (picked.length < count) {
    const before = picked.length;

    for (let day = 0; day < days.length && picked.length < count; day += 1) {
      const remaining = days[day].filter((slot) => !used[day].has(slot.start));
      if (remaining.length === 0) continue;

      const preferred = picked.length % 2 === 0 ? 0 : Math.floor(remaining.length * 0.6);
      const slot = remaining[Math.min(preferred, remaining.length - 1)];

      used[day].add(slot.start);
      picked.push(slot);
    }

    if (picked.length === before) break;
  }

  return picked.sort((a, b) => a.start - b.start);
}

function extractMeetLink(event) {
  if (event?.hangoutLink) return event.hangoutLink;

  const entryPoints = event?.conferenceData?.entryPoints;
  if (!Array.isArray(entryPoints)) return null;

  const video = entryPoints.find((entry) => entry?.entryPointType === "video" && entry?.uri);
  return video?.uri || entryPoints.find((entry) => entry?.uri)?.uri || null;
}

function buildSummary(agent = {}, leadName, leadEmail) {
  const company = agent.agent_company_name || agent.company_name || "our team";
  const lead = leadName || leadEmail || "your team";
  return `Intro call: ${company} <> ${lead}`;
}

function buildDescription(agent = {}) {
  const company = agent.agent_company_name || agent.company_name;
  return company
    ? `Scheduled automatically after a positive reply. Looking forward to speaking with you — ${company}.`
    : "Scheduled automatically after a positive reply.";
}

module.exports = new MeetingBookingService();
module.exports.__testables = {
  buildWorkingWindows,
  firstFreeSlot,
  candidateSlotsByDay,
  pickSpreadSlots,
  zonedWallClockToUtc,
  parseTimeOfDay,
  resolveAgentSettings,
  extractMeetLink,
};
