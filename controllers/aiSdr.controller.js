const db = require("../config/db.config");
const quotaService = require("../services/quota.service");
const inboxService = require("../services/inbox.service");
const threadState = require("../services/sdr/threadState.service");
const settingsService = require("../services/sdr/settings.service");
const webhook = require("../services/sdr/webhook.service");
const scheduling = require("../services/sdr/scheduling.service");
const forwardService = require("../services/sdr/forward.service");
const sdrInbound = require("../services/sdr/inbound.service");

function sendError(res, error, fallback) {
  if (quotaService.isQuotaError(error)) return res.status(403).json(quotaService.errorBody(error));
  const status = error.statusCode || 500;
  if (status >= 500) console.error(fallback, error);
  res.status(status).json({ success: false, message: status >= 500 ? fallback : error.message, code: error.code || "AI_SDR_REQUEST_FAILED", data: null });
}

const ok = (res, message, data) => res.status(200).json({ success: true, message, data });

/** Settings change what the SDR says on the company's behalf, so only owners and admins may edit them. */
function isSettingsEditor(req) {
  return Boolean(req.user?.isSuperAdmin) || ["owner", "admin"].includes(req.workspace?.role);
}

const settingsRoute = (message, handler) => async (req, res) => {
  if (req.method !== "GET" && !isSettingsEditor(req)) {
    return res.status(403).json({ success: false, message: "Only workspace owners and admins can change AI SDR settings.", code: "FORBIDDEN", data: null });
  }
  try {
    ok(res, message, await handler(req));
  } catch (error) {
    sendError(res, error, message);
  }
};

const route = (message, handler) => async (req, res) => {
  try {
    ok(res, message, await handler(req));
  } catch (error) {
    sendError(res, error, message);
  }
};

const ids = (req) => ({ mailboxId: Number(req.params.mailboxId), threadId: String(req.params.threadId) });

async function sendAndRecord({ workspaceId, mailboxId, threadId, body, author }) {
  const sent = await inboxService.sendReply(mailboxId, threadId, { body }, workspaceId);
  await db.query(`UPDATE messages SET author = $3 WHERE id = $1 AND workspace_id = $2`, [sent.id, workspaceId, author]);
  await threadState.patch(workspaceId, mailboxId, threadId, { needsAttention: false }, { by: "manual" }).catch(() => null);
  await db.query(
    `UPDATE sdr_drafts SET status = 'discarded', updated_at = NOW() WHERE workspace_id = $1 AND mailbox_id = $2 AND thread_id = $3 AND status = 'pending'`,
    [workspaceId, mailboxId, threadId]
  );
  await db.query(
    `UPDATE crm_tasks SET status = 'done', completed_at = NOW() WHERE workspace_id = $1 AND record_type = 'thread' AND record_id = $2 AND source = 'ai_sdr' AND status = 'open'`,
    [workspaceId, `${mailboxId}:${threadId}`]
  );
  return sent;
}

module.exports = {
  listThreads: route("Unable to load threads", (req) => threadState.list(req.workspaceId, req.query)),
  listCampaigns: route("Unable to load campaigns", (req) => threadState.campaignsWithThreads(req.workspaceId)),
  getThread: route("Unable to load the thread", (req) => {
    const { mailboxId, threadId } = ids(req);
    return threadState.detail(req.workspaceId, mailboxId, threadId);
  }),
  patchThread: route("Unable to update the thread", async (req) => {
    const { mailboxId, threadId } = ids(req);
    const input = { ...(req.body || {}) };
    if (input.followUpAt !== undefined) {
      if (input.followUpAt === null) {
        input.followupBy = null;
      } else {
        const when = new Date(input.followUpAt).getTime();
        if (!Number.isFinite(when) || when < Date.now() - 60000) throw Object.assign(new Error("Choose a follow-up time in the future."), { statusCode: 400 });
        if (when > Date.now() + 90 * 86400000) throw Object.assign(new Error("Schedule a follow-up within the next three months."), { statusCode: 400 });
        input.followUpAt = new Date(when).toISOString();
        input.followupBy = "manual";
      }
    }
    await threadState.patch(req.workspaceId, mailboxId, threadId, input, { by: "manual" });
    return threadState.detail(req.workspaceId, mailboxId, threadId);
  }),
  bulk: route("Unable to update threads", (req) => threadState.bulk(req.workspaceId, req.body?.threads, req.body?.action)),

  reply: route("Unable to send the reply", async (req) => {
    const { mailboxId, threadId } = ids(req);
    const sent = await sendAndRecord({ workspaceId: req.workspaceId, mailboxId, threadId, body: req.body?.body, author: "human" });
    return { id: sent.id };
  }),

  sendDraft: route("Unable to send the draft", async (req) => {
    const { mailboxId, threadId } = ids(req);
    const { rows } = await db.query(
      `SELECT * FROM sdr_drafts WHERE id = $1 AND workspace_id = $2 AND mailbox_id = $3 AND thread_id = $4 AND status = 'pending'`,
      [Number(req.params.draftId), req.workspaceId, mailboxId, threadId]
    );
    const draft = rows[0];
    if (!draft) throw Object.assign(new Error("That draft is no longer pending."), { statusCode: 409 });
    const edited = typeof req.body?.body === "string" && req.body.body.trim() && req.body.body.trim() !== draft.body.trim();
    let body = edited ? req.body.body : draft.body;
    if (draft.booking) {
      // The draft confirms a time the prospect picked; make the booking now that a person approved it.
      const booking = typeof draft.booking === "string" ? JSON.parse(draft.booking) : draft.booking;
      const handler = await scheduling.resolveHandler(req.workspaceId, booking.handlerUserId);
      if (!handler) throw Object.assign(new Error("The call handler's calendar is no longer connected."), { statusCode: 409 });
      const [{ rows: types }, { rows: inboundRows }] = await Promise.all([
        db.query(`SELECT * FROM meeting_types WHERE id = $1 AND workspace_id = $2`, [booking.meetingTypeId, req.workspaceId]),
        db.query(`SELECT m.from_address, cl.full_name FROM messages m LEFT JOIN campaign_leads cl ON cl.id = m.campaign_lead_id WHERE m.workspace_id = $1 AND m.mailbox_id = $2 AND m.thread_id = $3 AND m.direction = 'inbound' ORDER BY m.id DESC LIMIT 1`, [req.workspaceId, mailboxId, threadId]),
      ]);
      const booked = await scheduling.book({
        workspaceId: req.workspaceId, mailboxId, threadId, offer: { id: booking.offerId }, slot: booking.slot, handler, meetingType: types[0] || null,
        lead: { email: inboundRows[0]?.from_address || null, name: inboundRows[0]?.full_name || null },
      });
      if (!booked.success) {
        throw Object.assign(new Error(booked.reason === "taken" ? "That time is no longer free. Discard this draft and offer new times." : "The calendar booking failed. Check the calendar connection and try again."), { statusCode: 409 });
      }
      if (booked.meetLink && !body.includes(booked.meetLink)) {
        const cut = body.lastIndexOf("\n\n");
        body = cut > 0 ? `${body.slice(0, cut)}\n\nVideo link: ${booked.meetLink}${body.slice(cut)}` : `${body}\n\nVideo link: ${booked.meetLink}`;
      }
      await threadState.patch(req.workspaceId, mailboxId, threadId, { outcome: "meeting_booked", interest: "very_high" }, { by: "ai" });
    }
    const sent = await sendAndRecord({ workspaceId: req.workspaceId, mailboxId, threadId, body, author: edited ? "human" : "ai" });
    if (!edited && !draft.booking) await sdrInbound.afterAiSend({ workspaceId: req.workspaceId, mailboxId, threadId }).catch(() => null);
    await db.query(`UPDATE sdr_drafts SET status = 'sent', updated_at = NOW() WHERE id = $1 AND workspace_id = $2`, [draft.id, req.workspaceId]);
    return { id: sent.id };
  }),

  discardDraft: route("Unable to discard the draft", async (req) => {
    const result = await db.query(
      `UPDATE sdr_drafts SET status = 'discarded', updated_at = NOW() WHERE id = $1 AND workspace_id = $2 AND status = 'pending'`,
      [Number(req.params.draftId), req.workspaceId]
    );
    if (result.rowCount === 0) throw Object.assign(new Error("That draft is no longer pending."), { statusCode: 409 });
    return { discarded: true };
  }),

  forward: route("Unable to forward the message", (req) => {
    const { mailboxId, threadId } = ids(req);
    return forwardService.forward({ workspaceId: req.workspaceId, userId: req.user?.id, mailboxId, threadId, messageId: Number(req.params.messageId), to: req.body?.to, note: req.body?.note });
  }),

  listOverrides: settingsRoute("Unable to load campaign settings", (req) => settingsService.listOverrides(req.workspaceId)),
  saveOverride: settingsRoute("Unable to save campaign settings", (req) => settingsService.saveOverride(req.workspaceId, Number(req.params.campaignId), req.body || {})),
  clearOverride: settingsRoute("Unable to reset campaign settings", async (req) => {
    await settingsService.clearOverride(req.workspaceId, Number(req.params.campaignId));
    return { cleared: true };
  }),

  getSettings: settingsRoute("Unable to load AI SDR settings", (req) => settingsService.getAll(req.workspaceId)),
  updateSettings: settingsRoute("Unable to save AI SDR settings", (req) => settingsService.updateSettings(req.workspaceId, req.body || {})),
  updateRules: settingsRoute("Unable to save rules", (req) => settingsService.replaceRules(req.workspaceId, req.body?.rules)),
  updateBrain: settingsRoute("Unable to save the Brain", (req) => settingsService.updateBrain(req.workspaceId, req.body || {})),
  createMeetingType: settingsRoute("Unable to add the meeting type", (req) => settingsService.createMeetingType(req.workspaceId, req.body || {})),
  updateMeetingType: settingsRoute("Unable to save the meeting type", (req) => settingsService.updateMeetingType(req.workspaceId, Number(req.params.id), req.body || {})),
  deleteMeetingType: settingsRoute("Unable to delete the meeting type", async (req) => {
    await settingsService.deleteMeetingType(req.workspaceId, Number(req.params.id));
    return { deleted: true };
  }),
  createResource: settingsRoute("Unable to add the resource", (req) => settingsService.createResource(req.workspaceId, req.body || {})),
  deleteResource: settingsRoute("Unable to delete the resource", async (req) => {
    await settingsService.deleteResource(req.workspaceId, Number(req.params.id));
    return { deleted: true };
  }),

  revealWebhookSecret: settingsRoute("Unable to load the webhook secret", async (req) => ({ secret: await settingsService.getWebhookSecret(req.workspaceId) })),
  rotateWebhookSecret: settingsRoute("Unable to rotate the webhook secret", async (req) => ({ secret: await settingsService.rotateWebhookSecret(req.workspaceId) })),
  testWebhook: settingsRoute("Unable to send the test event", async (req) => {
    const all = await settingsService.loadForPrompt(req.workspaceId);
    if (!all.settings.webhookUrl) throw Object.assign(new Error("Save a webhook URL first."), { statusCode: 400 });
    if (!all.webhookSecret) throw Object.assign(new Error("Save the webhook URL again to generate a signing secret."), { statusCode: 400 });
    const result = await webhook
      .deliver({ url: all.settings.webhookUrl, secret: all.webhookSecret, event: "test", data: { message: "This is a test event from SendVybe." } })
      .catch((error) => {
        throw Object.assign(new Error(`We couldn't reach your endpoint: ${error.message}`), { statusCode: 502 });
      });
    return result;
  }),
};
