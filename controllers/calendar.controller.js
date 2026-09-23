const googleCalendarService = require("../services/googleCalendar.service");

async function listConnections(req, res) {
  try {
    const data = await googleCalendarService.listConnections(req.query.agentId ?? req.query.agent_id);

    res.status(200).json({
      success: true,
      message: "Calendar connections fetched successfully",
      data,
      count: data.length,
    });
  } catch (error) {
    sendError(res, error, "Unable to fetch calendar connections");
  }
}

async function getGoogleAuthUrl(req, res) {
  try {
    const url = googleCalendarService.getAuthUrl(req.query.agentId ?? req.query.agent_id);

    res.status(200).json({
      success: true,
      message: "Google Calendar authorization URL generated successfully",
      data: { url },
    });
  } catch (error) {
    sendError(res, error, "Unable to start the Google Calendar connection");
  }
}

/**
 * Browser redirect target for the OAuth popup — responds with HTML, not JSON,
 * so the popup can notify its opener and close itself.
 */
async function handleGoogleCallback(req, res) {
  try {
    await googleCalendarService.handleCallback(req.query.code, req.query.state);

    res.status(200).type("html").send(buildPopupPage({ type: "google-calendar-connected" }));
  } catch (error) {
    console.error("Google Calendar callback failed:", error.message);

    res.status(error.statusCode || 500).type("html").send(
      buildPopupPage({ type: "google-calendar-error", message: error.message || "Connection failed" })
    );
  }
}

async function disconnectConnection(req, res) {
  try {
    const data = await googleCalendarService.disconnectConnection(req.params.id);

    res.status(200).json({
      success: true,
      message: "Calendar connection removed successfully",
      data,
    });
  } catch (error) {
    sendError(res, error, "Unable to remove the calendar connection");
  }
}

function buildPopupPage(message) {
  const payload = JSON.stringify(message).replace(/</g, "\\u003c");
  const heading = message.type === "google-calendar-connected"
    ? "Google Calendar connected"
    : "Google Calendar connection failed";
  const detail = message.type === "google-calendar-connected"
    ? "You can close this window."
    : escapeHtml(message.message || "");

  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <title>${heading}</title>
    <style>
      body { font-family: system-ui, -apple-system, "Segoe UI", sans-serif; margin: 0; display: grid; place-items: center; min-height: 100vh; background: #0f172a; color: #e2e8f0; }
      main { text-align: center; padding: 24px; }
      h1 { font-size: 18px; margin: 0 0 8px; }
      p { font-size: 14px; margin: 0; color: #94a3b8; }
    </style>
  </head>
  <body>
    <main>
      <h1>${heading}</h1>
      <p>${detail}</p>
    </main>
    <script>
      window.opener?.postMessage(${payload}, '*');
      window.close();
    </script>
  </body>
</html>`;
}

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function sendError(res, error, fallbackMessage) {
  res.status(error.statusCode || 500).json({
    success: false,
    message: error.message || fallbackMessage,
    code: error.code || "CALENDAR_REQUEST_FAILED",
    data: null,
  });
}

module.exports = {
  listConnections,
  getGoogleAuthUrl,
  handleGoogleCallback,
  disconnectConnection,
};
