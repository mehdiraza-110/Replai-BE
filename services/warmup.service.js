const db = require("../config/db.config");
const { mapMailboxRow } = require("./mailbox.service");

const OPENAI_MODEL = "gpt-4o-mini";

// Fixed severity ladder behind the three tiers the UI exposes (Something goes wrong / very wrong /
// extremely wrong). Thresholds follow the same AWS-published bounce/complaint guidance already used
// for domain reputation labels (see domain.service.js reputationLabelFor).
const SEVERITY_LADDER = [
  { key: "extremely-wrong", bounceRate: 0.1, complaintRate: 0.005 },
  { key: "very-wrong", bounceRate: 0.08, complaintRate: 0.003 },
  { key: "wrong", bounceRate: 0.05, complaintRate: 0.001 },
];

const DEFAULT_SAFETY_TIERS = [
  { key: "wrong", label: "Something goes wrong", description: "Bounce or complaint rate creeps above threshold.", action: "decrement", amount: 5 },
  { key: "very-wrong", label: "Something goes very wrong", description: "Bounce or complaint rate spikes sharply.", action: "decrement", amount: 10 },
  { key: "extremely-wrong", label: "Something goes extremely wrong", description: "Blacklist hit or sustained high complaint rate.", action: "stop", amount: 0 },
];

class WarmupService {
  async listStrategies() {
    const { rows } = await db.query(
      `SELECT ws.*, COUNT(m.id) FILTER (WHERE m.is_deleted = FALSE)::int AS assigned_mailbox_count
       FROM warmup_strategies ws
       LEFT JOIN mailboxes m ON m.warmup_strategy_id = ws.id
       WHERE ws.is_deleted = FALSE
       GROUP BY ws.id
       ORDER BY ws.created_at DESC`
    );
    return rows.map(mapStrategyRow);
  }

  async getSummary() {
    const [{ rows: mailboxRows }, { rows: strategyRows }] = await Promise.all([
      db.query(
        `SELECT m.warmup_stage, m.daily_limit, ws.steady_state_daily_limit
         FROM mailboxes m
         JOIN warmup_strategies ws ON ws.id = m.warmup_strategy_id
         WHERE m.is_deleted = FALSE AND m.warmup_strategy_id IS NOT NULL`
      ),
      db.query(
        `SELECT COUNT(DISTINCT ws.id)::int AS count
         FROM warmup_strategies ws
         JOIN mailboxes m ON m.warmup_strategy_id = ws.id
         WHERE ws.is_deleted = FALSE AND m.is_deleted = FALSE`
      ),
    ]);

    const inWarmup = mailboxRows.filter((row) => row.warmup_stage !== "Paused").length;
    const atSteadyState = mailboxRows.filter((row) => row.warmup_stage === "Steady State").length;
    const avgProgress = mailboxRows.length
      ? Math.round(
          mailboxRows.reduce((sum, row) => {
            const pct = row.steady_state_daily_limit > 0 ? Math.min(100, (row.daily_limit / row.steady_state_daily_limit) * 100) : 0;
            return sum + pct;
          }, 0) / mailboxRows.length
        )
      : 0;

    return {
      inWarmup,
      atSteadyState,
      avgProgress,
      activeStrategies: strategyRows[0]?.count || 0,
    };
  }

  async createStrategy({ name, description, startDailyLimit, steadyStateDailyLimit, incrementPerStage, stageDurationDays, safetyTiers, isAiGenerated, aiRationale, createdBy }) {
    if (!name) throw Object.assign(new Error("name is required"), { statusCode: 400 });

    const { rows } = await db.query(
      `INSERT INTO warmup_strategies (
         name, description, start_daily_limit, steady_state_daily_limit,
         increment_per_stage, stage_duration_days, safety_tiers, is_ai_generated, ai_rationale, created_by, updated_at
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, NOW())
       RETURNING *, 0 AS assigned_mailbox_count`,
      [
        name,
        description || null,
        clampPositiveInt(startDailyLimit, 5),
        clampPositiveInt(steadyStateDailyLimit, 40),
        clampPositiveInt(incrementPerStage, 5),
        clampPositiveInt(stageDurationDays, 7),
        JSON.stringify(safetyTiers && safetyTiers.length ? safetyTiers : DEFAULT_SAFETY_TIERS),
        Boolean(isAiGenerated),
        aiRationale || null,
        createdBy || null,
      ]
    );
    return mapStrategyRow(rows[0]);
  }

  async assignStrategy(strategyId, target) {
    const { rows: strategyRows } = await db.query(`SELECT * FROM warmup_strategies WHERE id = $1 AND is_deleted = FALSE`, [strategyId]);
    const strategy = strategyRows[0];
    if (!strategy) throw Object.assign(new Error("Warmup strategy not found"), { statusCode: 404 });

    const conditions = ["is_deleted = FALSE"];
    const params = [];

    if (target?.mailboxIds?.length) {
      params.push(target.mailboxIds);
      conditions.push(`id = ANY($${params.length})`);
    } else if (target?.domain) {
      params.push(target.domain);
      conditions.push(`domain_id = (SELECT id FROM domains WHERE domain = $${params.length})`);
    } else if (!target?.all) {
      throw Object.assign(new Error("Provide mailboxIds, domain, or all:true"), { statusCode: 400 });
    }

    params.push(strategyId, strategy.start_daily_limit);
    const { rows } = await db.query(
      `UPDATE mailboxes SET
         warmup_strategy_id = $${params.length - 1},
         daily_limit = $${params.length},
         warmup_stage = 'New',
         warmup_started_at = NOW(),
         warmup_last_tick_at = NULL,
         warmup_last_action = NULL,
         updated_at = NOW()
       WHERE ${conditions.join(" AND ")}
       RETURNING *`,
      params
    );

    return { strategy: mapStrategyRow(strategy), assignedCount: rows.length };
  }

  async generateAiSchedule({ domain, mailboxIds }) {
    if (!process.env.OPENAI_API_KEY) {
      throw Object.assign(new Error("OPENAI_API_KEY is not configured on the server"), { statusCode: 503, code: "OPENAI_NOT_CONFIGURED" });
    }

    const context = await this.buildAiContext({ domain, mailboxIds });

    const response = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: OPENAI_MODEL,
        temperature: 0.3,
        response_format: { type: "json_object" },
        messages: [
          {
            role: "system",
            content:
              "You design cold-email mailbox warmup ramp schedules for a B2B outreach platform. " +
              "A ramp schedule gradually raises a mailbox's daily send limit from a low starting volume to a steady-state ceiling, " +
              "in fixed-size increments applied every N days, so as not to trigger spam filters or damage sender reputation. " +
              "Never propose a start limit above 10/day or a steady-state limit above 50/day for a brand-new domain with no send history. " +
              "If the domain already has real send/bounce/complaint history, factor it in: a domain with elevated bounce or complaint " +
              "rates should get a slower, more conservative ramp (smaller increments, longer stage duration). " +
              'Respond ONLY with strict JSON: {"startDailyLimit": number, "steadyStateDailyLimit": number, "incrementPerStage": number, ' +
              '"stageDurationDays": number, "weeklySchedule": [{"label": string, "range": string}], "rationale": string}. ' +
              "weeklySchedule should have one entry per ramp stage (label like \"Week 1\", \"Week 2\", … ending in \"Week N+ (steady state)\"), " +
              'range formatted like "8–14/day". rationale is 1-2 sentences explaining the numbers given the context provided.',
          },
          { role: "user", content: JSON.stringify(context, null, 2) },
        ],
      }),
    });

    const payload = await response.json().catch(() => ({}));
    if (!response.ok) {
      throw Object.assign(new Error(payload?.error?.message || "OpenAI request failed"), { statusCode: 502 });
    }

    const content = payload.choices?.[0]?.message?.content;
    let schedule;
    try {
      schedule = JSON.parse(content);
    } catch {
      throw Object.assign(new Error("OpenAI returned a response that could not be parsed"), { statusCode: 502 });
    }

    return {
      startDailyLimit: clampPositiveInt(schedule.startDailyLimit, 5),
      steadyStateDailyLimit: clampPositiveInt(schedule.steadyStateDailyLimit, 40),
      incrementPerStage: clampPositiveInt(schedule.incrementPerStage, 5),
      stageDurationDays: clampPositiveInt(schedule.stageDurationDays, 7),
      weeklySchedule: Array.isArray(schedule.weeklySchedule) ? schedule.weeklySchedule : [],
      rationale: typeof schedule.rationale === "string" ? schedule.rationale : null,
      context,
    };
  }

  async buildAiContext({ domain, mailboxIds }) {
    let domainRows = [];
    if (domain) {
      const { rows } = await db.query(
        `SELECT domain, status, emails_sent_14d, emails_delivered_14d, emails_bounced_14d, emails_complained_14d, bounce_rate, complaint_rate, reputation
         FROM domains WHERE domain = $1 AND is_deleted = FALSE`,
        [domain]
      );
      domainRows = rows;
    } else if (mailboxIds?.length) {
      const { rows } = await db.query(
        `SELECT DISTINCT d.domain, d.status, d.emails_sent_14d, d.emails_delivered_14d, d.emails_bounced_14d, d.emails_complained_14d, d.bounce_rate, d.complaint_rate, d.reputation
         FROM mailboxes m JOIN domains d ON d.id = m.domain_id
         WHERE m.id = ANY($1) AND m.is_deleted = FALSE`,
        [mailboxIds]
      );
      domainRows = rows;
    } else {
      const { rows } = await db.query(
        `SELECT domain, status, emails_sent_14d, emails_delivered_14d, emails_bounced_14d, emails_complained_14d, bounce_rate, complaint_rate, reputation
         FROM domains WHERE is_deleted = FALSE ORDER BY created_at DESC LIMIT 20`
      );
      domainRows = rows;
    }

    return {
      targetScope: domain ? `single domain (${domain})` : mailboxIds?.length ? `${mailboxIds.length} specific mailbox(es)` : "all onboarded domains",
      domains: domainRows.map((row) => ({
        domain: row.domain,
        verificationStatus: row.status,
        last14Days: {
          sent: row.emails_sent_14d ?? 0,
          delivered: row.emails_delivered_14d ?? 0,
          bounced: row.emails_bounced_14d ?? 0,
          complained: row.emails_complained_14d ?? 0,
          bounceRate: row.bounce_rate,
          complaintRate: row.complaint_rate,
        },
        reputation: row.reputation,
      })),
    };
  }

  // The engine. Advances every mailbox with an assigned strategy according to its ramp curve,
  // and enforces the strategy's safety tiers against its parent domain's real bounce/complaint
  // rate (mailboxes share a domain's SES configuration set, so reputation is tracked at that level).
  async runTick() {
    const { rows } = await db.query(
      `SELECT m.*, d.domain AS domain_name, d.status AS domain_status, d.bounce_rate AS domain_bounce_rate, d.complaint_rate AS domain_complaint_rate,
              ws.name AS warmup_strategy_name, ws.start_daily_limit, ws.steady_state_daily_limit, ws.steady_state_market_daily_limit, ws.increment_per_stage, ws.stage_duration_days, ws.safety_tiers
       FROM mailboxes m
       JOIN warmup_strategies ws ON ws.id = m.warmup_strategy_id AND ws.is_deleted = FALSE
       JOIN domains d ON d.id = m.domain_id
       WHERE m.is_deleted = FALSE AND m.warmup_stage != 'Paused'`
    );

    const results = [];
    for (const row of rows) {
      try {
        results.push(await this.tickMailbox(row));
      } catch (error) {
        results.push({ mailboxId: row.id, email: row.email, error: error.message });
      }
    }
    return results;
  }

  async tickMailbox(row) {
    const daysSinceStart = row.warmup_started_at
      ? Math.max(0, Math.floor((Date.now() - new Date(row.warmup_started_at).getTime()) / 86_400_000))
      : 0;
    const stageIndex = Math.floor(daysSinceStart / row.stage_duration_days);
    const rampTargetLimit = Math.min(row.steady_state_daily_limit, row.start_daily_limit + stageIndex * row.increment_per_stage);

    const bounceRate = row.domain_bounce_rate === null ? null : Number(row.domain_bounce_rate);
    const complaintRate = row.domain_complaint_rate === null ? null : Number(row.domain_complaint_rate);
    const tiers = Array.isArray(row.safety_tiers) ? row.safety_tiers : DEFAULT_SAFETY_TIERS;
    const breach = bounceRate !== null ? findBreach(tiers, bounceRate, complaintRate) : null;

    let dailyLimit = rampTargetLimit;
    let warmupStage = rampTargetLimit >= row.steady_state_daily_limit ? "Steady State" : daysSinceStart === 0 ? "New" : "Ramping";
    let reputationStatus = "Healthy";
    let warmupLastAction = null;
    let mailboxStatus = row.status === "Error" ? "Error" : "Active";

    if (breach) {
      const metricPct = breach.metric === "bounceRate" ? `${(bounceRate * 100).toFixed(1)}% bounce rate` : `${(complaintRate * 100).toFixed(2)}% complaint rate`;
      if (breach.tier.action === "stop") {
        warmupStage = "Paused";
        mailboxStatus = "Paused";
        reputationStatus = "At Risk";
        warmupLastAction = `Paused automatically: ${breach.tier.label.toLowerCase()} — ${row.domain_name} at ${metricPct}. Sending stopped until reviewed.`;
      } else {
        dailyLimit = Math.max(row.start_daily_limit, rampTargetLimit - (breach.tier.amount || 0));
        warmupStage = dailyLimit >= row.steady_state_daily_limit ? "Steady State" : "Ramping";
        reputationStatus = "Watch";
        warmupLastAction = `Pulled back by ${breach.tier.amount}/day: ${breach.tier.label.toLowerCase()} — ${row.domain_name} at ${metricPct}.`;
      }
    }

    // Market lane only unlocks once the mailbox has actually reached (and stayed at) Steady
    // State — a pullback that drops it back into Ramping also drops market volume to 0 for
    // that day, since a reputation issue serious enough to pause the ramp shouldn't be
    // masked by continuing to run real campaign sends on the same mailbox.
    const marketDailyLimit = warmupStage === "Steady State" ? row.steady_state_market_daily_limit : 0;

    const { rows: updatedRows } = await db.query(
      `UPDATE mailboxes SET
         daily_limit = $2,
         warmup_stage = $3,
         reputation_status = $4,
         status = $5,
         warmup_last_action = $6,
         warmup_last_tick_at = NOW(),
         sent_today = 0,
         market_daily_limit = $7,
         market_sent_today = 0,
         updated_at = NOW()
       WHERE id = $1
       RETURNING *`,
      [row.id, dailyLimit, warmupStage, reputationStatus, mailboxStatus, warmupLastAction, marketDailyLimit]
    );

    return mapMailboxRow({
      ...updatedRows[0],
      domain_name: row.domain_name,
      domain_status: row.domain_status,
      domain_bounce_rate: row.domain_bounce_rate,
      domain_complaint_rate: row.domain_complaint_rate,
      warmup_strategy_name: row.warmup_strategy_name,
    });
  }
}

function findBreach(tiers, bounceRate, complaintRate) {
  const tierByKey = Object.fromEntries(tiers.map((tier) => [tier.key, tier]));
  for (const severity of SEVERITY_LADDER) {
    const tier = tierByKey[severity.key];
    if (!tier) continue;
    const bounceBreached = bounceRate !== null && bounceRate > severity.bounceRate;
    const complaintBreached = complaintRate !== null && complaintRate > severity.complaintRate;
    if (bounceBreached || complaintBreached) {
      return { tier, metric: complaintBreached && (!bounceBreached || complaintRate / severity.complaintRate > bounceRate / severity.bounceRate) ? "complaintRate" : "bounceRate" };
    }
  }
  return null;
}

function clampPositiveInt(value, fallback) {
  const n = Number.parseInt(value, 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

function mapStrategyRow(row) {
  if (!row) return null;
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    startDailyLimit: row.start_daily_limit,
    steadyStateDailyLimit: row.steady_state_daily_limit,
    incrementPerStage: row.increment_per_stage,
    stageDurationDays: row.stage_duration_days,
    safetyTiers: row.safety_tiers,
    isAiGenerated: row.is_ai_generated,
    aiRationale: row.ai_rationale,
    assignedMailboxCount: row.assigned_mailbox_count ?? 0,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

module.exports = new WarmupService();
module.exports.DEFAULT_SAFETY_TIERS = DEFAULT_SAFETY_TIERS;
