const suppressionService = require("../services/suppression.service");

// Public link click (GET) — recipient lands here from the email footer, no auth, no confirmation step.
async function unsubscribe(req, res) {
  try {
    const result = await suppressionService.unsubscribeByToken(req.params.token);
    res.status(200).set("Content-Type", "text/html").send(renderPage({
      title: "You're unsubscribed",
      message: result?.email
        ? `${result.email} has been removed from our mailing list. You will not receive further emails from us.`
        : "You have been unsubscribed. You will not receive further emails from us.",
    }));
  } catch (error) {
    res.status(error.statusCode || 400).set("Content-Type", "text/html").send(renderPage({
      title: "Unsubscribe link invalid",
      message: error.message || "This unsubscribe link could not be processed.",
    }));
  }
}

// One-click unsubscribe (RFC 8058 List-Unsubscribe-Post) — mail providers POST here directly, no page shown.
async function unsubscribeOneClick(req, res) {
  try {
    await suppressionService.unsubscribeByToken(req.params.token);
    res.status(200).json({ success: true });
  } catch (error) {
    res.status(error.statusCode || 400).json({ success: false, message: error.message });
  }
}

function renderPage({ title, message }) {
  return `<!DOCTYPE html>
<html lang="en">
<head><meta charset="utf-8"><title>${escapeHtml(title)}</title>
<meta name="viewport" content="width=device-width, initial-scale=1">
<style>body{font-family:system-ui,-apple-system,sans-serif;max-width:480px;margin:80px auto;padding:0 24px;color:#1a1a1a;text-align:center}h1{font-size:20px}p{color:#555;line-height:1.5}</style>
</head>
<body><h1>${escapeHtml(title)}</h1><p>${escapeHtml(message)}</p></body>
</html>`;
}

function escapeHtml(value) {
  return String(value || "").replace(/[&<>"']/g, (char) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;",
  }[char]));
}

module.exports = { unsubscribe, unsubscribeOneClick };
