const suppressionService = require("../services/suppression.service");

// Link click (GET): only shows a confirm button. Corporate mail scanners and link prefetchers open every URL in an
// email, so unsubscribing on GET silently opted out real, interested replies. The POST below does the unsubscribe.
async function unsubscribe(req, res) {
  try {
    const { email } = suppressionService.verifyUnsubscribeToken(req.params.token);
    res.status(200).set("Content-Type", "text/html").send(renderPage({
      title: "Unsubscribe",
      message: `Stop receiving emails at ${email}?`,
      action: `/api/v1/unsubscribe/${encodeURIComponent(req.params.token)}`,
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
    const result = await suppressionService.unsubscribeByToken(req.params.token);
    // The confirm button on the GET page posts a form with confirm=1; mail providers post List-Unsubscribe=One-Click.
    if (req.body?.confirm) {
      return res.status(200).set("Content-Type", "text/html").send(renderPage({
        title: "You're unsubscribed",
        message: result?.email
          ? `${result.email} has been removed from our mailing list. You will not receive further emails from us.`
          : "You have been unsubscribed. You will not receive further emails from us.",
      }));
    }
    res.status(200).json({ success: true });
  } catch (error) {
    res.status(error.statusCode || 400).json({ success: false, message: error.message });
  }
}

function renderPage({ title, message, action = null }) {
  return `<!DOCTYPE html>
<html lang="en">
<head><meta charset="utf-8"><title>${escapeHtml(title)}</title>
<meta name="viewport" content="width=device-width, initial-scale=1">
<style>body{font-family:system-ui,-apple-system,sans-serif;max-width:480px;margin:80px auto;padding:0 24px;color:#1a1a1a;text-align:center}h1{font-size:20px}p{color:#555;line-height:1.5}</style>
</head>
<body><h1>${escapeHtml(title)}</h1><p>${escapeHtml(message)}</p>${action ? `<form method="post" action="${escapeHtml(action)}"><input type="hidden" name="confirm" value="1"><button type="submit" style="padding:10px 20px;font-size:15px;border:0;border-radius:8px;background:#111;color:#fff;cursor:pointer">Confirm unsubscribe</button></form>` : ""}</body>
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
