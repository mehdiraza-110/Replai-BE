const db = require("../config/db.config");
const eventLogService = require("./eventLog.service");

const DEFAULT_DAYS = 30;

class AnalyticsService {
  async getOverview(query = {}) {
    const startedAt = Date.now();
    const range = normalizeRange(query);
    const rangeParams = [range.startDate, range.endDate];
    const comparisonParams = [range.startDate, range.endDate, range.previousStartDate];

    const [
      summary,
      weeklyLoop,
      intentMix,
      reviewTriggers,
      trainingImpact,
      agentPerformance,
    ] = await Promise.all([
      getSummary(comparisonParams),
      getWeeklyLoop(rangeParams),
      getIntentMix(rangeParams),
      getReviewTriggers(rangeParams),
      getTrainingImpact(rangeParams),
      getAgentPerformance(rangeParams),
    ]);

    const data = {
      range: {
        preset: range.preset,
        startDate: range.startDate,
        endDate: range.endDate,
        label: range.label,
      },
      summary,
      weeklyLoop,
      intentMix,
      reviewTriggers,
      trainingImpact,
      agentPerformance,
    };

    await eventLogService.record({
      eventType: "analytics.viewed",
      source: "analytics",
      status: "Success",
      durationMs: Date.now() - startedAt,
      metadata: { preset: range.preset, startDate: range.startDate, endDate: range.endDate },
    });

    return data;
  }
}

async function getSummary(params) {
  const result = await db.query(
    `WITH bounds AS (
       SELECT $1::timestamptz AS current_start,
              $2::timestamptz AS current_end,
              $3::timestamptz AS previous_start
     ),
     incoming AS (
       SELECT
         COUNT(*) FILTER (WHERE received_at >= (SELECT current_start FROM bounds) AND received_at < (SELECT current_end FROM bounds))::int AS current_count,
         COUNT(*) FILTER (WHERE received_at >= (SELECT previous_start FROM bounds) AND received_at < (SELECT current_start FROM bounds))::int AS previous_count
       FROM plusvibe_webhook_events
     ),
     ai_sent AS (
       SELECT
         COUNT(*) FILTER (WHERE status = 'Sent' AND updated_at >= (SELECT current_start FROM bounds) AND updated_at < (SELECT current_end FROM bounds))::int AS current_count,
         COUNT(*) FILTER (WHERE status = 'Sent' AND updated_at >= (SELECT previous_start FROM bounds) AND updated_at < (SELECT current_start FROM bounds))::int AS previous_count
       FROM ai_response_drafts
       WHERE is_deleted = FALSE
     ),
     reviewed AS (
       SELECT
         COUNT(*) FILTER (WHERE created_at >= (SELECT current_start FROM bounds) AND created_at < (SELECT current_end FROM bounds))::int AS current_count,
         COUNT(*) FILTER (WHERE created_at >= (SELECT previous_start FROM bounds) AND created_at < (SELECT current_start FROM bounds))::int AS previous_count
       FROM event_logs
       WHERE event_type IN ('ai.draft.approved_sent', 'ai.draft.rejected', 'plusvibe.reply.manual_sent')
     ),
     meetings AS (
       SELECT
         COUNT(*) FILTER (WHERE received_at >= (SELECT current_start FROM bounds) AND received_at < (SELECT current_end FROM bounds))::int AS current_count,
         COUNT(*) FILTER (WHERE received_at >= (SELECT previous_start FROM bounds) AND received_at < (SELECT current_start FROM bounds))::int AS previous_count
       FROM plusvibe_webhook_events
       WHERE UPPER(REPLACE(REPLACE(COALESCE(payload->>'label', payload->>'event_type', payload->>'eventType', webhook_event, ''), '-', '_'), ' ', '_')) = 'MEETING_REQUEST'
     )
     SELECT json_build_array(
       json_build_object(
         'label', 'Prospect replies',
         'value', incoming.current_count,
         'change', CASE WHEN incoming.previous_count = 0 THEN '+' || incoming.current_count::text ELSE (ROUND(((incoming.current_count - incoming.previous_count)::numeric / incoming.previous_count) * 100)::int)::text || '%' END,
         'tone', 'accent',
         'icon', 'MessageSquareText'
       ),
       json_build_object(
         'label', 'AI replies sent',
         'value', ai_sent.current_count,
         'change', CASE WHEN incoming.current_count = 0 THEN '0%' ELSE (ROUND((ai_sent.current_count::numeric / incoming.current_count) * 100)::int)::text || '%' END,
         'tone', 'success',
         'icon', 'Bot'
       ),
       json_build_object(
         'label', 'Human reviewed',
         'value', reviewed.current_count,
         'change', CASE WHEN incoming.current_count = 0 THEN '0%' ELSE (ROUND((reviewed.current_count::numeric / incoming.current_count) * 100)::int)::text || '%' END,
         'tone', 'warning',
         'icon', 'UserCheck'
       ),
       json_build_object(
         'label', 'Meeting requests',
         'value', meetings.current_count,
         'change', CASE WHEN meetings.previous_count = 0 THEN '+' || meetings.current_count::text ELSE (ROUND(((meetings.current_count - meetings.previous_count)::numeric / meetings.previous_count) * 100)::int)::text || '%' END,
         'tone', 'success',
         'icon', 'Target'
       )
     ) AS data
     FROM incoming, ai_sent, reviewed, meetings`,
    params
  );

  return result.rows[0]?.data || [];
}

async function getWeeklyLoop(params) {
  const result = await db.query(
    `WITH days AS (
       SELECT generate_series(
         date_trunc('day', $1::timestamptz),
         date_trunc('day', $2::timestamptz - INTERVAL '1 second'),
         INTERVAL '1 day'
       ) AS day_start
     ),
     incoming AS (
       SELECT date_trunc('day', received_at) AS day_start, COUNT(*)::int AS count
       FROM plusvibe_webhook_events
       WHERE received_at >= $1::timestamptz AND received_at < $2::timestamptz
       GROUP BY 1
     ),
     sent AS (
       SELECT date_trunc('day', updated_at) AS day_start, COUNT(*)::int AS count
       FROM ai_response_drafts
       WHERE status = 'Sent'
         AND is_deleted = FALSE
         AND updated_at >= $1::timestamptz AND updated_at < $2::timestamptz
       GROUP BY 1
       UNION ALL
       SELECT date_trunc('day', created_at) AS day_start, COUNT(*)::int AS count
       FROM event_logs
       WHERE event_type = 'plusvibe.reply.manual_sent'
         AND created_at >= $1::timestamptz AND created_at < $2::timestamptz
       GROUP BY 1
     ),
     sent_totals AS (
       SELECT day_start, SUM(count)::int AS count FROM sent GROUP BY 1
     ),
     review AS (
       SELECT date_trunc('day', created_at) AS day_start, COUNT(*)::int AS count
       FROM ai_response_drafts
       WHERE status IN ('Pending', 'Rejected')
         AND is_deleted = FALSE
         AND created_at >= $1::timestamptz AND created_at < $2::timestamptz
       GROUP BY 1
     )
     SELECT to_char(days.day_start, 'Dy') AS day,
            to_char(days.day_start, 'YYYY-MM-DD') AS date,
            COALESCE(incoming.count, 0) AS incoming,
            COALESCE(sent_totals.count, 0) AS sent,
            COALESCE(review.count, 0) AS review
     FROM days
     LEFT JOIN incoming ON incoming.day_start = days.day_start
     LEFT JOIN sent_totals ON sent_totals.day_start = days.day_start
     LEFT JOIN review ON review.day_start = days.day_start
     ORDER BY days.day_start`,
    params
  );

  return result.rows.map((row) => ({
    day: row.day,
    date: row.date,
    incoming: Number(row.incoming),
    sent: Number(row.sent),
    review: Number(row.review),
  }));
}

async function getIntentMix(params) {
     const result = await db.query(
    `WITH labels AS (
       SELECT UPPER(REPLACE(REPLACE(COALESCE(payload->>'label', payload->>'event_type', payload->>'eventType', webhook_event, ''), '-', '_'), ' ', '_')) AS label,
              COUNT(*)::int AS count
       FROM plusvibe_webhook_events
       WHERE received_at >= $1::timestamptz AND received_at < $2::timestamptz
       GROUP BY 1
     ),
     mapped AS (
       SELECT CASE
                WHEN label = 'QUESTION' THEN 'Questions'
                WHEN label = 'INTERESTED' THEN 'Interested'
                WHEN label = 'MEETING_REQUEST' THEN 'Meeting requests'
                WHEN label = 'NOT_INTERESTED' THEN 'Not interested'
                WHEN label = 'OBJECTION' THEN 'Objections'
                WHEN label = 'AUTOMATIC_REPLY' THEN 'Automatic replies'
                ELSE initcap(replace(lower(label), '_', ' '))
              END AS label,
              count
       FROM labels
       WHERE label IS NOT NULL AND label <> ''
     ),
     totals AS (SELECT COALESCE(SUM(count), 0)::int AS total FROM mapped)
     SELECT mapped.label,
            mapped.count,
            CASE WHEN totals.total = 0 THEN 0 ELSE ROUND((mapped.count::numeric / totals.total) * 100)::int END AS value
     FROM mapped, totals
     ORDER BY mapped.count DESC
     LIMIT 6`,
    params
  );

  return result.rows.map((row, index) => ({
    label: row.label,
    value: Number(row.value),
    count: Number(row.count),
    color: ["bg-accent", "bg-success", "bg-warning", "bg-foreground/60", "bg-danger", "bg-default-400"][index] || "bg-default-400",
  }));
}

async function getReviewTriggers(params) {
  const result = await db.query(
    `WITH triggers AS (
       SELECT 'Low confidence draft' AS label, COUNT(*)::int AS count
       FROM ai_response_drafts
       WHERE confidence < 80
         AND created_at >= $1::timestamptz AND created_at < $2::timestamptz
         AND is_deleted = FALSE
       UNION ALL
       SELECT 'AI provider fallback' AS label, COUNT(*)::int AS count
       FROM ai_response_drafts
       WHERE generation_error IS NOT NULL
         AND created_at >= $1::timestamptz AND created_at < $2::timestamptz
         AND is_deleted = FALSE
       UNION ALL
       SELECT 'Rejected by reviewer' AS label, COUNT(*)::int AS count
       FROM ai_response_drafts
       WHERE status = 'Rejected'
         AND updated_at >= $1::timestamptz AND updated_at < $2::timestamptz
         AND is_deleted = FALSE
       UNION ALL
       SELECT 'Manual reply used' AS label, COUNT(*)::int AS count
       FROM event_logs
       WHERE event_type = 'plusvibe.reply.manual_sent'
         AND created_at >= $1::timestamptz AND created_at < $2::timestamptz
       UNION ALL
       SELECT 'Approval required' AS label, COUNT(*)::int AS count
       FROM ai_response_drafts
       WHERE status = 'Pending'
         AND created_at >= $1::timestamptz AND created_at < $2::timestamptz
         AND is_deleted = FALSE
     ),
     totals AS (SELECT GREATEST(SUM(count), 1)::int AS total FROM triggers)
     SELECT label,
            count,
            ROUND((count::numeric / totals.total) * 100)::int AS value
     FROM triggers, totals
     WHERE count > 0
     ORDER BY count DESC
     LIMIT 5`,
    params
  );

  return result.rows.map((row) => ({
    label: row.label,
    value: Number(row.value),
    count: Number(row.count),
  }));
}

async function getTrainingImpact(params) {
  const result = await db.query(
    `WITH drafts AS (
       SELECT *
       FROM ai_response_drafts
       WHERE created_at >= $1::timestamptz AND created_at < $2::timestamptz
         AND is_deleted = FALSE
     ),
     draft_events AS (
       SELECT duration_ms
       FROM event_logs
       WHERE event_type IN ('ai.draft.generated', 'ai.draft.regenerated')
         AND duration_ms IS NOT NULL
         AND created_at >= $1::timestamptz AND created_at < $2::timestamptz
     )
     SELECT COALESCE(ROUND(AVG(confidence))::int, 0) AS objective_alignment,
            COALESCE(ROUND(AVG(confidence) FILTER (WHERE status = 'Sent'))::int, 0) AS sent_confidence,
            COALESCE(ROUND(PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY duration_ms))::int, 0) AS median_draft_ms
     FROM drafts
     FULL OUTER JOIN draft_events ON FALSE`
  , params);

  const row = result.rows[0] || {};
  const medianMs = Number(row.median_draft_ms) || 0;

  return [
    {
      label: "Sent confidence",
      value: `${Number(row.sent_confidence) || 0}%`,
      description: "Average confidence for AI replies that were approved and sent.",
      tone: "success",
      icon: "TrendingUp",
    },
    {
      label: "Median draft time",
      value: medianMs ? `${(medianMs / 1000).toFixed(1)}s` : "0s",
      description: "Median time spent generating or regenerating reviewable AI drafts.",
      tone: "accent",
      icon: "Clock3",
    },
    {
      label: "Objective alignment",
      value: `${Number(row.objective_alignment) || 0}%`,
      description: "Average confidence across generated AI drafts in this period.",
      tone: "default",
      icon: "Target",
    },
  ];
}

async function getAgentPerformance(params) {
  const result = await db.query(
    `SELECT COALESCE(a.name, 'Unassigned agent') AS agent,
            COALESCE(a.assigned_inbox_name, 'PlusVibe') AS inbox,
            COUNT(d.id)::int AS replies,
            COUNT(d.id) FILTER (WHERE d.status = 'Sent')::int AS sent,
            COALESCE(ROUND(AVG(d.confidence))::int, 0) AS confidence,
            COUNT(d.id) FILTER (WHERE d.plusvibe_campaign_id IN (
              SELECT campaign_id
              FROM plusvibe_webhook_events
              WHERE UPPER(REPLACE(REPLACE(COALESCE(payload->>'label', payload->>'event_type', payload->>'eventType', webhook_event, ''), '-', '_'), ' ', '_')) = 'MEETING_REQUEST'
                AND received_at >= $1::timestamptz AND received_at < $2::timestamptz
            ))::int AS meetings,
            CASE
              WHEN COUNT(d.id) FILTER (WHERE d.generation_error IS NOT NULL) > 0 THEN 'AI provider fallback'
              WHEN COUNT(d.id) FILTER (WHERE d.confidence < 80) > 0 THEN 'Low confidence'
              WHEN COUNT(d.id) FILTER (WHERE d.status = 'Rejected') > 0 THEN 'Rejected drafts'
              ELSE 'None'
            END AS review
     FROM ai_response_drafts d
     LEFT JOIN ai_agents a ON a.id = d.ai_agent_id
     WHERE d.created_at >= $1::timestamptz AND d.created_at < $2::timestamptz
       AND d.is_deleted = FALSE
     GROUP BY a.id, a.name, a.assigned_inbox_name
     ORDER BY replies DESC
     LIMIT 6`,
    params
  );

  return result.rows.map((row) => ({
    agent: row.agent,
    inbox: row.inbox,
    replies: Number(row.replies),
    autoSent: percent(Number(row.sent), Number(row.replies)),
    confidence: `${Number(row.confidence)}%`,
    meetings: Number(row.meetings),
    review: row.review,
  }));
}

function normalizeRange(query) {
  const now = new Date();
  const customStart = parseDateOnly(query.startDate || query.start_date);
  const customEnd = parseDateOnly(query.endDate || query.end_date);

  if (customStart && customEnd) {
    const start = startOfDay(customStart);
    const end = addDays(startOfDay(customEnd), 1);

    if (end <= start) {
      const error = new Error("Analytics end date must be after the start date");
      error.statusCode = 400;
      throw error;
    }

    return buildRange("custom", start, end, `${formatShortDate(start)} - ${formatShortDate(addDays(end, -1))}`);
  }

  const preset = cleanPreset(query.preset) || normalizeDaysPreset(query.days);

  if (preset === "last_7_days") {
    return buildRange(preset, addDays(now, -6), now, "Last 7 days");
  }

  if (preset === "month_to_date") {
    return buildRange(preset, new Date(now.getFullYear(), now.getMonth(), 1), now, "Month to date");
  }

  if (preset === "last_90_days") {
    return buildRange(preset, addDays(now, -90), now, "Last 90 days");
  }

  return buildRange("last_30_days", addDays(now, -DEFAULT_DAYS), now, "Last 30 days");
}

function buildRange(preset, startDate, endDate, label) {
  const start = startOfDay(startDate);
  const end = endDate;
  const durationMs = Math.max(24 * 60 * 60 * 1000, end.getTime() - start.getTime());

  return {
    preset,
    startDate: start.toISOString(),
    endDate: end.toISOString(),
    previousStartDate: new Date(start.getTime() - durationMs).toISOString(),
    label,
  };
}

function normalizeDaysPreset(value) {
  const days = Number(value);
  if (days === 7) return "last_7_days";
  if (days === 90) return "last_90_days";
  return "last_30_days";
}

function cleanPreset(value) {
  const preset = String(value || "").trim();
  return ["last_7_days", "month_to_date", "last_30_days", "last_90_days"].includes(preset) ? preset : null;
}

function parseDateOnly(value) {
  const text = String(value || "").trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) return null;

  const date = new Date(`${text}T00:00:00`);
  return Number.isNaN(date.getTime()) ? null : date;
}

function startOfDay(date) {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate());
}

function addDays(date, days) {
  const next = new Date(date);
  next.setDate(next.getDate() + days);
  return next;
}

function formatShortDate(date) {
  return new Intl.DateTimeFormat("en", {
    month: "short",
    day: "numeric",
  }).format(date);
}

function percent(part, total) {
  if (!total) return "0%";
  return `${Math.round((part / total) * 100)}%`;
}

module.exports = new AnalyticsService();
