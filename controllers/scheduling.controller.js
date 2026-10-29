const googleCalendar = require("../services/googleCalendar.service");
const scheduling = require("../services/sdr/scheduling.service");

function sendError(res, error, fallback) {
  const status = error.statusCode || 500;
  if (status >= 500) console.error(fallback, error);
  res.status(status).json({ success: false, message: status >= 500 ? fallback : error.message, code: error.code || "SCHEDULING_REQUEST_FAILED", data: null });
}

const route = (message, handler) => async (req, res) => {
  try {
    res.status(200).json({ success: true, message, data: await handler(req) });
  } catch (error) {
    sendError(res, error, message);
  }
};

const googleConfigured = () => Boolean(process.env.GOOGLE_CALENDAR_CLIENT_ID && process.env.GOOGLE_CALENDAR_CLIENT_SECRET && process.env.GOOGLE_CALENDAR_REDIRECT_URI);

// Availability and the calendar belong to the signed-in person: nobody edits a teammate's hours or disconnects their calendar.
module.exports = {
  getAvailability: route("Unable to load availability", (req) => scheduling.getAvailability(req.workspaceId, req.user.id)),
  saveAvailability: route("Unable to save availability", (req) => scheduling.saveAvailability(req.workspaceId, req.user.id, req.body || {})),
  getCalendar: route("Unable to load the calendar connection", async (req) => ({
    connection: await googleCalendar.getUserConnectionStatus(req.workspaceId, req.user.id),
    googleConfigured: googleConfigured(),
  })),
  connectUrl: route("Unable to start the Google connection", async (req) => {
    if (!googleConfigured()) throw Object.assign(new Error("Google Calendar is not set up on this server yet."), { statusCode: 503 });
    return { url: await googleCalendar.getUserAuthUrl(req.workspaceId, req.user.id) };
  }),
  disconnect: route("Unable to disconnect the calendar", (req) => googleCalendar.disconnectForUser(req.workspaceId, req.user.id)),
};
