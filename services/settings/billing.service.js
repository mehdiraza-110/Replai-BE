const db = require("../../config/db.config");

/** What the workspace has: plan and limits (from the request's workspace), domains with their inboxes, and open requests. */
async function summary(workspace) {
  const [domains, orders] = await Promise.all([
    db.query(
      `SELECT d.id, d.domain, d.status, d.provider, d.created_at,
         COUNT(m.id) FILTER (WHERE m.is_deleted = FALSE)::int AS inboxes,
         COUNT(m.id) FILTER (WHERE m.is_deleted = FALSE AND m.status = 'Active')::int AS active_inboxes
       FROM domains d LEFT JOIN mailboxes m ON m.domain_id = d.id
       WHERE d.workspace_id = $1 AND COALESCE(d.is_deleted, FALSE) = FALSE GROUP BY d.id ORDER BY d.domain LIMIT 1000`,
      [workspace.id]
    ),
    db.query(`SELECT COUNT(*)::int AS n FROM provisioning_requests WHERE workspace_id = $1 AND status IN ('requested','approved','in_progress')`, [workspace.id]),
  ]);
  const rows = domains.rows.map((d) => ({ id: d.id, domain: d.domain, status: d.status, provider: d.provider, inboxes: d.inboxes, activeInboxes: d.active_inboxes, addedAt: d.created_at }));
  return {
    plan: workspace.plan || null,
    domains: rows,
    totals: { domains: rows.length, inboxes: rows.reduce((n, d) => n + d.inboxes, 0), activeInboxes: rows.reduce((n, d) => n + d.activeInboxes, 0) },
    openRequests: orders.rows[0].n,
  };
}

module.exports = { summary };
