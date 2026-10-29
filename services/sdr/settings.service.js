const crypto = require("crypto");
const db = require("../../config/db.config");
const { assertSafeUrl } = require("./webhook.service");

const bad = (message) => Object.assign(new Error(message), { statusCode: 400 });
const clean = (value, max) => String(value ?? "").trim().slice(0, max);

const BRAIN_FIELDS = {
  companyName: ["company_name", 220],
  website: ["website", 400],
  whoYouSellTo: ["who_you_sell_to", 4000],
  whatYouSell: ["what_you_sell", 4000],
  podcastName: ["podcast_name", 220],
  senderFirstName: ["sender_first_name", 120],
  senderLastName: ["sender_last_name", 120],
  senderTitle: ["sender_title", 180],
  senderEmail: ["sender_email", 350],
  senderContact: ["sender_contact", 400],
  senderAddress: ["sender_address", 400],
};

const MAX_KNOWLEDGE_BASE = 60000;
const MAX_RULES = 50;

function mapBrain(row) {
  const brain = {};
  for (const [key, [column]] of Object.entries(BRAIN_FIELDS)) brain[key] = row?.[column] ?? "";
  return brain;
}

function mapMeetingType(row) {
  return {
    id: row.id,
    name: row.name,
    campaignType: row.campaign_type,
    durationMinutes: row.duration_minutes,
    calendarTitle: row.calendar_title,
    isDefault: row.is_default,
  };
}

class SdrSettingsService {
  /** Everything the AI SDR settings page shows, in one read. Creates the default row/meeting type on first use. */
  async getAll(workspaceId) {
    await db.query(`INSERT INTO sdr_settings (workspace_id) VALUES ($1) ON CONFLICT DO NOTHING`, [workspaceId]);
    const { rows: existingTypes } = await db.query(`SELECT id FROM meeting_types WHERE workspace_id = $1 LIMIT 1`, [workspaceId]);
    if (existingTypes.length === 0) {
      await db.query(
        `INSERT INTO meeting_types (workspace_id, name, campaign_type, duration_minutes, calendar_title, is_default)
         VALUES ($1, 'Intro Call', 'Direct', 30, 'Intro Call - Prospect Name', TRUE)`,
        [workspaceId]
      );
    }

    const [settings, rules, types, resources, brain, handlers] = await Promise.all([
      db.query(`SELECT * FROM sdr_settings WHERE workspace_id = $1`, [workspaceId]),
      db.query(`SELECT id, rule FROM sdr_rules WHERE workspace_id = $1 ORDER BY position, id`, [workspaceId]),
      db.query(`SELECT * FROM meeting_types WHERE workspace_id = $1 ORDER BY is_default DESC, id`, [workspaceId]),
      db.query(`SELECT r.id, r.title, r.url, r.campaign_id, c.name AS campaign_name FROM sdr_resources r LEFT JOIN campaigns c ON c.id = r.campaign_id WHERE r.workspace_id = $1 ORDER BY r.id`, [workspaceId]),
      db.query(`SELECT * FROM workspace_brain WHERE workspace_id = $1`, [workspaceId]),
      db.query(
        `SELECT u.id, u.email, u.first_name, u.last_name, wm.role
         FROM workspace_members wm JOIN users u ON u.id = wm.user_id
         WHERE wm.workspace_id = $1
         ORDER BY CASE wm.role WHEN 'owner' THEN 0 WHEN 'admin' THEN 1 ELSE 2 END, u.id`,
        [workspaceId]
      ),
    ]);
    const s = settings.rows[0];
    return {
      settings: {
        enabled: s.enabled,
        requireApproval: s.require_approval,
        knowledgeBase: s.knowledge_base,
        callHandlerUserId: s.call_handler_user_id,
        bookingLink: s.booking_link || "",
        webhookUrl: s.webhook_url || "",
        webhookSecretSet: Boolean(s.webhook_secret),
        followupEnabled: s.followup_enabled,
        followupDelayDays: s.followup_delay_days,
        followupMax: s.followup_max,
      },
      rules: rules.rows.map((row) => ({ id: row.id, rule: row.rule })),
      meetingTypes: types.rows.map(mapMeetingType),
      resources: resources.rows.map((row) => ({ id: row.id, title: row.title, url: row.url, campaignId: row.campaign_id, campaignName: row.campaign_name })),
      brain: mapBrain(brain.rows[0]),
      handlers: handlers.rows.map((row) => ({
        id: row.id,
        email: row.email,
        name: [row.first_name, row.last_name].filter(Boolean).join(" ") || row.email,
        role: row.role,
      })),
    };
  }

  async updateSettings(workspaceId, input) {
    const fields = [];
    const values = [workspaceId];
    const set = (column, value) => {
      values.push(value);
      fields.push(`${column} = $${values.length}`);
    };

    if (input.enabled !== undefined) set("enabled", Boolean(input.enabled));
    if (input.requireApproval !== undefined) set("require_approval", Boolean(input.requireApproval));
    if (input.knowledgeBase !== undefined) {
      const text = String(input.knowledgeBase);
      if (text.length > MAX_KNOWLEDGE_BASE) throw bad(`The knowledge base is limited to ${MAX_KNOWLEDGE_BASE} characters.`);
      set("knowledge_base", text);
    }
    if (input.bookingLink !== undefined) {
      const link = clean(input.bookingLink, 800);
      if (link && !/^https?:\/\//i.test(link)) throw bad("The booking link must start with http:// or https://");
      set("booking_link", link || null);
    }
    if (input.callHandlerUserId !== undefined) {
      const userId = input.callHandlerUserId ? Number(input.callHandlerUserId) : null;
      if (userId) {
        const { rows } = await db.query(`SELECT 1 FROM workspace_members WHERE workspace_id = $1 AND user_id = $2`, [workspaceId, userId]);
        if (rows.length === 0) throw bad("That person is not a member of this workspace.");
      }
      set("call_handler_user_id", userId);
    }
    if (input.followupEnabled !== undefined) set("followup_enabled", Boolean(input.followupEnabled));
    if (input.followupDelayDays !== undefined) {
      const days = Number.parseInt(input.followupDelayDays, 10);
      if (!Number.isInteger(days) || days < 1 || days > 30) throw bad("Wait between 1 and 30 days before a follow-up.");
      set("followup_delay_days", days);
    }
    if (input.followupMax !== undefined) {
      const max = Number.parseInt(input.followupMax, 10);
      if (!Number.isInteger(max) || max < 0 || max > 5) throw bad("Send between 0 and 5 follow-ups.");
      set("followup_max", max);
    }
    if (input.webhookUrl !== undefined) {
      const url = clean(input.webhookUrl, 800);
      if (url) await assertSafeUrl(url);
      set("webhook_url", url || null);
      if (url) {
        const { rows } = await db.query(`SELECT webhook_secret FROM sdr_settings WHERE workspace_id = $1`, [workspaceId]);
        if (!rows[0]?.webhook_secret) set("webhook_secret", crypto.randomBytes(24).toString("hex"));
      }
    }

    await db.query(`INSERT INTO sdr_settings (workspace_id) VALUES ($1) ON CONFLICT DO NOTHING`, [workspaceId]);
    if (fields.length > 0) {
      await db.query(`UPDATE sdr_settings SET ${fields.join(", ")}, updated_at = NOW() WHERE workspace_id = $1`, values);
    }
    return this.getAll(workspaceId);
  }

  /** The signing secret is shown only on request by someone who can change settings. */
  async getWebhookSecret(workspaceId) {
    const { rows } = await db.query(`SELECT webhook_secret FROM sdr_settings WHERE workspace_id = $1`, [workspaceId]);
    return rows[0]?.webhook_secret || null;
  }

  async rotateWebhookSecret(workspaceId) {
    const secret = crypto.randomBytes(24).toString("hex");
    await db.query(`INSERT INTO sdr_settings (workspace_id, webhook_secret) VALUES ($1, $2) ON CONFLICT (workspace_id) DO UPDATE SET webhook_secret = $2, updated_at = NOW()`, [workspaceId, secret]);
    return secret;
  }

  /** Replaces the whole rules list, preserving the order given. */
  async replaceRules(workspaceId, rules) {
    if (!Array.isArray(rules)) throw bad("rules must be a list.");
    const cleaned = rules.map((rule) => clean(typeof rule === "string" ? rule : rule?.rule, 2000)).filter(Boolean);
    if (cleaned.length > MAX_RULES) throw bad(`You can have at most ${MAX_RULES} rules.`);
    const client = await db.getClient();
    try {
      await client.query("BEGIN");
      await client.query(`DELETE FROM sdr_rules WHERE workspace_id = $1`, [workspaceId]);
      for (let index = 0; index < cleaned.length; index += 1) {
        await client.query(`INSERT INTO sdr_rules (workspace_id, rule, position) VALUES ($1, $2, $3)`, [workspaceId, cleaned[index], index]);
      }
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
    return this.getAll(workspaceId);
  }

  async updateBrain(workspaceId, input) {
    const columns = [];
    const values = [workspaceId];
    for (const [key, [column, max]] of Object.entries(BRAIN_FIELDS)) {
      if (input[key] === undefined) continue;
      values.push(clean(input[key], max));
      columns.push(column);
    }
    await db.query(`INSERT INTO workspace_brain (workspace_id) VALUES ($1) ON CONFLICT DO NOTHING`, [workspaceId]);
    if (columns.length > 0) {
      await db.query(`UPDATE workspace_brain SET ${columns.map((column, index) => `${column} = $${index + 2}`).join(", ")}, updated_at = NOW() WHERE workspace_id = $1`, values);
    }
    const { rows } = await db.query(`SELECT * FROM workspace_brain WHERE workspace_id = $1`, [workspaceId]);
    return mapBrain(rows[0]);
  }

  // ----- meeting types -----

  async createMeetingType(workspaceId, input) {
    const { name, campaignType, durationMinutes, calendarTitle } = this.#validateMeetingType(input);
    try {
      const { rows } = await db.query(
        `INSERT INTO meeting_types (workspace_id, name, campaign_type, duration_minutes, calendar_title) VALUES ($1, $2, $3, $4, $5) RETURNING *`,
        [workspaceId, name, campaignType, durationMinutes, calendarTitle]
      );
      return mapMeetingType(rows[0]);
    } catch (error) {
      if (error.code === "23505") throw bad("A meeting type with that name already exists.");
      throw error;
    }
  }

  async updateMeetingType(workspaceId, id, input) {
    const { name, campaignType, durationMinutes, calendarTitle } = this.#validateMeetingType(input);
    try {
      const { rows } = await db.query(
        `UPDATE meeting_types SET name = $3, campaign_type = $4, duration_minutes = $5, calendar_title = $6, updated_at = NOW()
         WHERE id = $1 AND workspace_id = $2 RETURNING *`,
        [id, workspaceId, name, campaignType, durationMinutes, calendarTitle]
      );
      if (!rows[0]) throw Object.assign(new Error("Meeting type not found."), { statusCode: 404 });
      return mapMeetingType(rows[0]);
    } catch (error) {
      if (error.code === "23505") throw bad("A meeting type with that name already exists.");
      throw error;
    }
  }

  async deleteMeetingType(workspaceId, id) {
    const { rows } = await db.query(`SELECT COUNT(*)::int AS count FROM meeting_types WHERE workspace_id = $1`, [workspaceId]);
    if (rows[0].count <= 1) throw bad("Keep at least one meeting type.");
    const result = await db.query(`DELETE FROM meeting_types WHERE id = $1 AND workspace_id = $2`, [id, workspaceId]);
    if (result.rowCount === 0) throw Object.assign(new Error("Meeting type not found."), { statusCode: 404 });
    // The default must always exist.
    await db.query(
      `UPDATE meeting_types SET is_default = TRUE WHERE id = (SELECT id FROM meeting_types WHERE workspace_id = $1 ORDER BY id LIMIT 1)
       AND NOT EXISTS (SELECT 1 FROM meeting_types WHERE workspace_id = $1 AND is_default)`,
      [workspaceId]
    );
  }

  #validateMeetingType(input) {
    const name = clean(input?.name, 120);
    if (!name) throw bad("Give the meeting type a name.");
    const durationMinutes = Number.parseInt(input?.durationMinutes, 10);
    if (!Number.isInteger(durationMinutes) || durationMinutes < 5 || durationMinutes > 480) throw bad("Choose a duration from 5 minutes up to 8 hours.");
    return {
      name,
      campaignType: clean(input?.campaignType, 80) || "Direct",
      durationMinutes,
      calendarTitle: clean(input?.calendarTitle, 220) || `${name} - Prospect Name`,
    };
  }

  // ----- resources -----

  async createResource(workspaceId, input) {
    const title = clean(input?.title, 220);
    const url = clean(input?.url, 2000);
    if (!title) throw bad("Give the resource a title.");
    if (!/^https?:\/\//i.test(url)) throw bad("The resource link must start with http:// or https://");
    const campaignId = input?.campaignId ? Number(input.campaignId) : null;
    if (campaignId) {
      const { rows } = await db.query(`SELECT 1 FROM campaigns WHERE id = $1 AND workspace_id = $2 AND is_deleted = FALSE`, [campaignId, workspaceId]);
      if (rows.length === 0) throw bad("That campaign does not exist.");
    }
    const { rows } = await db.query(`INSERT INTO sdr_resources (workspace_id, title, url, campaign_id) VALUES ($1, $2, $3, $4) RETURNING id, title, url, campaign_id`, [workspaceId, title, url, campaignId]);
    return { id: rows[0].id, title: rows[0].title, url: rows[0].url, campaignId: rows[0].campaign_id, campaignName: null };
  }

  async deleteResource(workspaceId, id) {
    const result = await db.query(`DELETE FROM sdr_resources WHERE id = $1 AND workspace_id = $2`, [id, workspaceId]);
    if (result.rowCount === 0) throw Object.assign(new Error("Resource not found."), { statusCode: 404 });
  }

  // ----- per-campaign overrides -----

  /** Every live campaign with its override (if any), for the "Manage campaign settings" screen. */
  async listOverrides(workspaceId) {
    const { rows } = await db.query(
      `SELECT c.id AS campaign_id, c.name AS campaign_name, o.enabled, o.require_approval, o.meeting_type_id, o.booking_link, COALESCE(o.notes, '') AS notes, (o.campaign_id IS NOT NULL) AS has_override
       FROM campaigns c LEFT JOIN sdr_campaign_overrides o ON o.campaign_id = c.id AND o.workspace_id = c.workspace_id
       WHERE c.workspace_id = $1 AND c.is_deleted = FALSE AND COALESCE(c.is_warmup, FALSE) = FALSE
       ORDER BY c.created_at DESC, c.id DESC`,
      [workspaceId]
    );
    return rows.map((row) => ({
      campaignId: row.campaign_id,
      campaignName: row.campaign_name,
      enabled: row.enabled,
      requireApproval: row.require_approval,
      meetingTypeId: row.meeting_type_id,
      bookingLink: row.booking_link || "",
      notes: row.notes,
      hasOverride: row.has_override,
    }));
  }

  async saveOverride(workspaceId, campaignId, input) {
    const { rows: campaign } = await db.query(`SELECT 1 FROM campaigns WHERE id = $1 AND workspace_id = $2 AND is_deleted = FALSE`, [campaignId, workspaceId]);
    if (campaign.length === 0) throw Object.assign(new Error("Campaign not found."), { statusCode: 404 });
    const tri = (value) => (value === null || value === undefined || value === "" ? null : Boolean(value));
    const link = clean(input?.bookingLink, 800);
    if (link && !/^https?:\/\//i.test(link)) throw bad("The booking link must start with http:// or https://");
    const notes = String(input?.notes ?? "");
    if (notes.length > 6000) throw bad("Campaign notes are limited to 6000 characters.");
    let meetingTypeId = input?.meetingTypeId ? Number(input.meetingTypeId) : null;
    if (meetingTypeId) {
      const { rows } = await db.query(`SELECT 1 FROM meeting_types WHERE id = $1 AND workspace_id = $2`, [meetingTypeId, workspaceId]);
      if (rows.length === 0) throw bad("That meeting type does not exist.");
    } else {
      meetingTypeId = null;
    }
    await db.query(
      `INSERT INTO sdr_campaign_overrides (workspace_id, campaign_id, enabled, require_approval, meeting_type_id, booking_link, notes)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       ON CONFLICT (workspace_id, campaign_id) DO UPDATE SET enabled = $3, require_approval = $4, meeting_type_id = $5, booking_link = $6, notes = $7, updated_at = NOW()`,
      [workspaceId, campaignId, tri(input?.enabled), tri(input?.requireApproval), meetingTypeId, link || null, notes]
    );
    return (await this.listOverrides(workspaceId)).find((item) => item.campaignId === campaignId);
  }

  async clearOverride(workspaceId, campaignId) {
    await db.query(`DELETE FROM sdr_campaign_overrides WHERE workspace_id = $1 AND campaign_id = $2`, [workspaceId, campaignId]);
  }

  /** Everything the reply prompt needs, in the shape agent.service.js expects, with the campaign's override merged in. */
  async loadForPrompt(workspaceId, campaignId = null) {
    const all = await this.getAll(workspaceId);
    const secret = await this.getWebhookSecret(workspaceId);
    const { rows } = campaignId
      ? await db.query(`SELECT * FROM sdr_campaign_overrides WHERE workspace_id = $1 AND campaign_id = $2`, [workspaceId, campaignId])
      : { rows: [] };
    const o = rows[0] || null;
    return {
      ...all,
      webhookSecret: secret,
      resources: all.resources.filter((resource) => resource.campaignId === null || resource.campaignId === campaignId),
      // A campaign can switch the SDR off or on, force approval, pick its own meeting type or link, and add notes. NULL = inherit.
      effective: {
        enabled: o?.enabled ?? all.settings.enabled,
        requireApproval: o?.require_approval ?? all.settings.requireApproval,
        bookingLink: o?.booking_link || all.settings.bookingLink,
        meetingTypeId: o?.meeting_type_id || null,
        notes: o?.notes || "",
      },
    };
  }
}

module.exports = new SdrSettingsService();
