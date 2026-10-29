const crypto = require("crypto");
const db = require("../../config/db.config");
const googleCalendar = require("../googleCalendar.service");
const meetingBooking = require("../meetingBooking.service");
const slotSelection = require("../slotSelection.service");
const workspaceSettings = require("../settings/preferences.service");

const { candidateSlotsByDay, pickSpreadSlots, zonedWallClockToUtc, extractMeetLink } = meetingBooking.__testables;

const DAY_KEYS = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];
const LOOKAHEAD_DAYS = 14;
const MIN_LEAD_MS = 2 * 60 * 60 * 1000; // never offer a time starting within two hours
const DEFAULT_WEEKLY = {
  mon: [["09:00", "17:00"]], tue: [["09:00", "17:00"]], wed: [["09:00", "17:00"]], thu: [["09:00", "17:00"]], fri: [["09:00", "17:00"]], sat: [], sun: [],
};
const bad = (message, statusCode = 400) => Object.assign(new Error(message), { statusCode });

function isValidTimezone(timezone) {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: timezone });
    return true;
  } catch {
    return false;
  }
}

/** The calendar date "now" falls on in `timezone`. */
function localDate(ms, timezone) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat("en-US", { timeZone: timezone, year: "numeric", month: "numeric", day: "numeric" }).formatToParts(new Date(ms)).map((p) => [p.type, p.value]));
  return { year: Number(parts.year), month: Number(parts.month), day: Number(parts.day) };
}

function parseTime(value) {
  const match = /^([01]?\d|2[0-3]):([0-5]\d)$/.exec(String(value || ""));
  return match ? { hour: Number(match[1]), minute: Number(match[2]) } : null;
}

/** Validates and normalises a weekly schedule. Throws a 400 with a plain message on bad input. */
function normaliseWeekly(weekly) {
  if (!weekly || typeof weekly !== "object") throw bad("Send a weekly schedule.");
  const out = {};
  let any = false;
  for (const key of DAY_KEYS) {
    const ranges = weekly[key] ?? [];
    if (!Array.isArray(ranges)) throw bad(`The hours for ${key} must be a list.`);
    if (ranges.length > 4) throw bad("Use at most four time ranges per day.");
    const cleaned = ranges.map((range) => {
      const start = parseTime(range?.[0]);
      const end = parseTime(range?.[1]);
      if (!start || !end) throw bad("Times must look like 09:00.");
      if (end.hour * 60 + end.minute <= start.hour * 60 + start.minute) throw bad("Each range must end after it starts.");
      return [range[0], range[1]];
    });
    out[key] = cleaned;
    if (cleaned.length) any = true;
  }
  if (!any) throw bad("At least one available time is required.");
  return out;
}

const provider = {
  fetchBusy: (connection, from, to, timezone) => meetingBooking.fetchBusy(connection, from, to, timezone),

  async createEvent(connection, { summary, description, startTime, endTime, timezone, attendees, staticLink }) {
    const accessToken = await googleCalendar.getValidAccessToken(connection);
    const calendarId = connection.calendar_id || "primary";
    const response = await fetch(`https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(calendarId)}/events?conferenceDataVersion=1&sendUpdates=all`, {
      method: "POST",
      headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        summary,
        description: staticLink ? `${description}\n\nJoin: ${staticLink}` : description,
        start: { dateTime: startTime, timeZone: timezone },
        end: { dateTime: endTime, timeZone: timezone },
        attendees,
        // The workspace can use one fixed meeting link (Settings > Conferencing) instead of a generated Google Meet room.
        ...(staticLink ? { location: staticLink } : { conferenceData: { createRequest: { requestId: crypto.randomUUID(), conferenceSolutionKey: { type: "hangoutsMeet" } } } }),
      }),
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(payload?.error?.message || `Google event creation failed with ${response.status}`);
    return { id: payload.id || null, meetLink: staticLink || extractMeetLink(payload) };
  },
};

class SchedulingService {
  constructor() {
    this.provider = provider; // replaced in tests
  }

  // ----- availability -----

  async getAvailability(workspaceId, userId) {
    const { rows } = await db.query(`SELECT * FROM user_availability WHERE workspace_id = $1 AND user_id = $2`, [workspaceId, userId]);
    const row = rows[0];
    return {
      timezone: row?.timezone || "UTC",
      weekly: row?.weekly || DEFAULT_WEEKLY,
      bufferBeforeMin: row?.buffer_before_min ?? 15,
      bufferAfterMin: row?.buffer_after_min ?? 15,
      saved: Boolean(row),
    };
  }

  async saveAvailability(workspaceId, userId, input) {
    const timezone = String(input?.timezone || "").trim();
    if (!isValidTimezone(timezone)) throw bad("Choose a valid time zone.");
    const weekly = normaliseWeekly(input?.weekly);
    const before = Number.parseInt(input?.bufferBeforeMin ?? 15, 10);
    const after = Number.parseInt(input?.bufferAfterMin ?? 15, 10);
    if (![before, after].every((n) => Number.isInteger(n) && n >= 0 && n <= 120)) throw bad("Buffers must be between 0 and 120 minutes.");
    await db.query(
      `INSERT INTO user_availability (workspace_id, user_id, timezone, weekly, buffer_before_min, buffer_after_min)
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (workspace_id, user_id) DO UPDATE SET timezone = $3, weekly = $4, buffer_before_min = $5, buffer_after_min = $6, updated_at = NOW()`,
      [workspaceId, userId, timezone, JSON.stringify(weekly), before, after]
    );
    return this.getAvailability(workspaceId, userId);
  }

  /** Working windows (ms) over the next two weeks in the handler's own time zone. */
  buildWindows(availability, now = new Date()) {
    const { timezone, weekly } = availability;
    const today = localDate(now.getTime(), timezone);
    const earliest = now.getTime() + MIN_LEAD_MS;
    const windows = [];
    for (let offset = 0; offset < LOOKAHEAD_DAYS; offset += 1) {
      const nominal = new Date(Date.UTC(today.year, today.month - 1, today.day + offset));
      const date = { year: nominal.getUTCFullYear(), month: nominal.getUTCMonth() + 1, day: nominal.getUTCDate() };
      for (const [from, to] of weekly[DAY_KEYS[nominal.getUTCDay()]] || []) {
        const start = parseTime(from);
        const end = parseTime(to);
        if (!start || !end) continue;
        const startMs = zonedWallClockToUtc({ ...date, ...start }, timezone);
        const endMs = zonedWallClockToUtc({ ...date, ...end }, timezone);
        const window = { start: Math.max(startMs, earliest), end: endMs };
        if (window.end > window.start) windows.push(window);
      }
    }
    return windows;
  }

  // ----- handler -----

  /**
   * The person who takes the calls: the configured handler, or else the best-ranked member (owner, admin, member)
   * who has a connected calendar. Null when nobody can take a call, in which case the SDR falls back to a booking link.
   */
  async resolveHandler(workspaceId, preferredUserId = null) {
    const { rows } = await db.query(
      `SELECT u.id, u.email, u.first_name, u.last_name FROM workspace_members wm JOIN users u ON u.id = wm.user_id
       WHERE wm.workspace_id = $1 AND ($2::int IS NULL OR u.id = $2)
       ORDER BY CASE wm.role WHEN 'owner' THEN 0 WHEN 'admin' THEN 1 ELSE 2 END, u.id`,
      [workspaceId, preferredUserId]
    );
    for (const user of rows) {
      const connection = await googleCalendar.getConnectedForUser(workspaceId, user.id);
      if (!connection) continue;
      const availability = await this.getAvailability(workspaceId, user.id);
      return { userId: user.id, email: user.email, name: [user.first_name, user.last_name].filter(Boolean).join(" ") || user.email, connection, availability };
    }
    return null;
  }

  async pickMeetingType(workspaceId, overrideId = null) {
    const { rows } = await db.query(
      `SELECT * FROM meeting_types WHERE workspace_id = $1 ORDER BY (id = $2) DESC, is_default DESC, id LIMIT 1`,
      [workspaceId, overrideId]
    );
    return rows[0] || null;
  }

  // ----- finding and offering slots -----

  formatSlot(startTime, timezone) {
    const parts = Object.fromEntries(
      new Intl.DateTimeFormat("en-US", { timeZone: timezone, weekday: "long", month: "short", day: "numeric", hour: "numeric", minute: "2-digit", timeZoneName: "short" })
        .formatToParts(new Date(startTime))
        .map((p) => [p.type, p.value])
    );
    return `${parts.weekday}, ${parts.month} ${parts.day} at ${parts.hour}:${parts.minute} ${parts.dayPeriod} ${parts.timeZoneName}`;
  }

  async findSlots(handler, durationMinutes, { count = 3, excludeStarts = [] } = {}) {
    const windows = this.buildWindows(handler.availability);
    if (windows.length === 0) return [];
    const { timezone, bufferBeforeMin, bufferAfterMin } = handler.availability;
    const busy = await this.provider.fetchBusy(handler.connection, windows[0].start, windows[windows.length - 1].end, timezone);
    const padded = busy.map((interval) => ({ start: interval.start - bufferBeforeMin * 60000, end: interval.end + bufferAfterMin * 60000 }));
    const excluded = new Set(excludeStarts.map((value) => new Date(value).getTime()));
    const days = candidateSlotsByDay(windows, padded, durationMinutes * 60000, excluded);
    return pickSpreadSlots(days, count).map((slot) => ({ startTime: new Date(slot.start).toISOString(), endTime: new Date(slot.end).toISOString() }));
  }

  /** Finds slots and records them as the thread's active offer (superseding any earlier one). Null when nothing is free. */
  async offerSlots({ workspaceId, mailboxId, threadId, handler, meetingType, count = 3 }) {
    const { rows: earlier } = await db.query(`SELECT slots FROM sdr_slot_offers WHERE workspace_id = $1 AND mailbox_id = $2 AND thread_id = $3`, [workspaceId, mailboxId, threadId]);
    const excludeStarts = earlier.flatMap((row) => row.slots.map((slot) => slot.startTime));
    const slots = await this.findSlots(handler, meetingType?.duration_minutes || 30, { count, excludeStarts });
    if (slots.length === 0) return null;
    await db.query(`UPDATE sdr_slot_offers SET status = 'superseded', updated_at = NOW() WHERE workspace_id = $1 AND mailbox_id = $2 AND thread_id = $3 AND status = 'offered'`, [workspaceId, mailboxId, threadId]);
    const { rows } = await db.query(
      `INSERT INTO sdr_slot_offers (workspace_id, mailbox_id, thread_id, handler_user_id, meeting_type_id, timezone, slots) VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *`,
      [workspaceId, mailboxId, threadId, handler.userId, meetingType?.id || null, handler.availability.timezone, JSON.stringify(slots)]
    );
    return this.#withLabels(rows[0]);
  }

  async activeOffer(workspaceId, mailboxId, threadId) {
    const { rows } = await db.query(
      `SELECT * FROM sdr_slot_offers WHERE workspace_id = $1 AND mailbox_id = $2 AND thread_id = $3 AND status = 'offered' AND created_at > NOW() - INTERVAL '7 days' ORDER BY id DESC LIMIT 1`,
      [workspaceId, mailboxId, threadId]
    );
    return rows[0] ? this.#withLabels(rows[0]) : null;
  }

  #withLabels(row) {
    return { ...row, slots: row.slots.map((slot) => ({ ...slot, label: this.formatSlot(slot.startTime, row.timezone) })) };
  }

  /** Which offered slot the prospect picked, by rules only. `{ selected: 1-based|null, decided: boolean }`. */
  detectSelection(text, offer) {
    return slotSelection.detect(text, offer.slots, offer.timezone);
  }

  // ----- booking -----

  /**
   * Books `slot` on the handler's calendar with a video link and the prospect as an attendee. Never throws for the
   * expected outcomes: `{ success: false, reason: "taken" | "error" }`. Safe to call twice for the same slot.
   */
  async book({ workspaceId, mailboxId, threadId, offer, slot, handler, meetingType, lead }) {
    const { rows: existing } = await db.query(
      `SELECT * FROM sdr_bookings WHERE workspace_id = $1 AND mailbox_id = $2 AND thread_id = $3 AND status = 'booked' AND scheduled_start = $4`,
      [workspaceId, mailboxId, threadId, slot.startTime]
    );
    if (existing[0]) return { success: true, meetLink: existing[0].meet_link, startTime: slot.startTime, endTime: slot.endTime, repeated: true };

    const start = new Date(slot.startTime).getTime();
    const end = new Date(slot.endTime).getTime();
    try {
      const busy = await this.provider.fetchBusy(handler.connection, start, end, handler.availability.timezone);
      if (start <= Date.now() || busy.some((interval) => interval.start < end && interval.end > start)) return { success: false, reason: "taken" };

      const conferencing = (await workspaceSettings.getWorkspaceSettings(workspaceId)).conferencing;
      const staticLink = conferencing.type === "static" && conferencing.staticUrl ? conferencing.staticUrl : null;
      const name = lead.name || lead.email;
      const title = String(meetingType?.calendar_title || "Call - Prospect Name").replace(/prospect name/i, name);
      const event = await this.provider.createEvent(handler.connection, {
        summary: title,
        description: "Booked by the SendVybe AI SDR after a positive reply.",
        startTime: slot.startTime,
        endTime: slot.endTime,
        timezone: handler.availability.timezone,
        attendees: lead.email ? [{ email: lead.email, ...(lead.name ? { displayName: lead.name } : {}) }] : [],
        staticLink,
      });
      await db.query(
        `INSERT INTO sdr_bookings (workspace_id, mailbox_id, thread_id, handler_user_id, meeting_type_id, lead_email, lead_name, google_event_id, meet_link, scheduled_start, scheduled_end)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
        [workspaceId, mailboxId, threadId, handler.userId, meetingType?.id || null, lead.email || null, lead.name || null, event.id, event.meetLink, slot.startTime, slot.endTime]
      );
      if (offer?.id) await db.query(`UPDATE sdr_slot_offers SET status = 'accepted', updated_at = NOW() WHERE id = $1 AND workspace_id = $2`, [offer.id, workspaceId]);
      return { success: true, meetLink: event.meetLink, eventId: event.id, startTime: slot.startTime, endTime: slot.endTime };
    } catch (error) {
      console.warn(`SDR booking failed for workspace ${workspaceId}:`, error.message);
      return { success: false, reason: "error", error: error.message };
    }
  }
}

module.exports = new SchedulingService();
module.exports.DEFAULT_WEEKLY = DEFAULT_WEEKLY;
module.exports.DAY_KEYS = DAY_KEYS;
module.exports.isValidTimezone = isValidTimezone;
