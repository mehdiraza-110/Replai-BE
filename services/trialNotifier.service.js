// Trial milestone emails: 7, 3 and 1 day(s) before trial_ends_at and once when the trial has ended, to the workspace
// owners and admins. Idempotent: each milestone is recorded in workspace_email_notifications (trial_ending_7/3/1,
// trial_ended), so repeated or overlapping runs never send twice. When a milestone was missed (server was down, trial
// created late) only the closest applicable one is sent.
const db = require("../config/db.config");
const systemMail = require("./systemMail.service");

const DAY_MS = 86400000;
const ENDED_GRACE_DAYS = 7; // never announce a trial that ended long ago (e.g. first run after deploy)
let running = false;
let timer = null;

function milestoneFor(msLeft) {
  if (msLeft <= 0) return "ended";
  if (msLeft <= DAY_MS) return 1;
  if (msLeft <= 3 * DAY_MS) return 3;
  if (msLeft <= 7 * DAY_MS) return 7;
  return null;
}

// `now` (Date or ms) is injectable so tests can control time.
async function runOnce(now = Date.now()) {
  const nowMs = now instanceof Date ? now.getTime() : Number(now);
  const sent = [];
  if (running) return { sent, skipped: true };
  running = true;
  try {
    // A restarted trial (trial_started_at newer than the recorded notice) starts a fresh notification cycle.
    await db.query(
      `DELETE FROM workspace_email_notifications n USING workspaces w
       WHERE n.workspace_id = w.id AND n.key LIKE 'trial\\_%' AND w.trial_started_at IS NOT NULL AND n.sent_at < w.trial_started_at`,
    );
    const { rows } = await db.query(
      `SELECT id, trial_ends_at::timestamptz AS trial_ends_at FROM workspaces
       WHERE plan = 'trial' AND trial_ends_at IS NOT NULL AND is_deleted = FALSE`,
    );
    for (const w of rows) {
      const msLeft = new Date(w.trial_ends_at).getTime() - nowMs;
      const milestone = milestoneFor(msLeft);
      if (milestone === null) continue;
      if (milestone === "ended" && -msLeft > ENDED_GRACE_DAYS * DAY_MS) continue;
      try {
        if (await systemMail.trialMilestone(w.id, milestone, w.trial_ends_at)) sent.push({ workspaceId: w.id, milestone });
      } catch (error) {
        console.error(`Trial notice failed for workspace ${w.id}:`, error.message);
      }
    }
  } catch (error) {
    console.error("Trial notifier run failed:", error.message);
  } finally {
    running = false;
  }
  return { sent };
}

// Hourly, first run about a minute after boot. The timers are unref()ed so they never keep the process alive.
function start() {
  if (timer) return;
  const first = setTimeout(() => {
    runOnce().catch(() => {});
    timer = setInterval(() => runOnce().catch(() => {}), 60 * 60 * 1000);
    timer.unref();
  }, 60 * 1000);
  first.unref();
  timer = first;
}

module.exports = { runOnce, start, milestoneFor };
