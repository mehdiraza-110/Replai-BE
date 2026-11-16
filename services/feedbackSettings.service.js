const db = require("../config/db.config");

// Platform-wide ticket settings, one JSON document in platform_settings under 'feedback.config'.
// normalize() fills gaps and drops unexpected keys so a hand-edited row can never break the flow.

const KEY = "feedback.config";
const HEIGHTS = [360, 480, 720];
const GID = /^[A-Za-z0-9_-]{1,64}$/;
const PREFIX = /^[A-Za-z0-9/_-]{1,100}$/;
const PROVIDERS = ["openai", "internal"];

const MAX_VIDEO_BYTES = 300 * 1024 * 1024;
const MAX_AUDIO_BYTES = 24 * 1024 * 1024; // the speech API accepts 25

const EMPTY_ASANA = { connectionUserId: null, workspaceGid: null, workspaceName: null, projectGid: null, projectName: null, assigneeGid: null, assigneeName: null };
const DEFAULTS = { s3Prefix: "", maxHeight: 720, maxDurationSeconds: 300, transcription: { provider: "openai" }, asana: EMPTY_ASANA };

function httpError(message, statusCode) {
  return Object.assign(new Error(message), { statusCode });
}

const str = (v, max = 200) => (typeof v === "string" && v.trim() ? v.trim().slice(0, max) : null);
const gid = (v) => (typeof v === "string" && GID.test(v) ? v : null);

function normalize(raw) {
  const r = raw && typeof raw === "object" ? raw : {};
  const a = r.asana && typeof r.asana === "object" ? r.asana : {};
  const duration = Number(r.maxDurationSeconds);
  const workspaceGid = gid(a.workspaceGid);
  return {
    s3Prefix: typeof r.s3Prefix === "string" && PREFIX.test(r.s3Prefix) ? r.s3Prefix : "",
    maxHeight: HEIGHTS.includes(Number(r.maxHeight)) ? Number(r.maxHeight) : DEFAULTS.maxHeight,
    maxDurationSeconds: Number.isFinite(duration) && duration >= 30 && duration <= 1800 ? Math.round(duration) : DEFAULTS.maxDurationSeconds,
    transcription: { provider: PROVIDERS.includes(r.transcription?.provider) ? r.transcription.provider : "openai" },
    asana: workspaceGid
      ? {
          connectionUserId: Number.isInteger(a.connectionUserId) ? a.connectionUserId : null,
          workspaceGid,
          workspaceName: str(a.workspaceName),
          projectGid: gid(a.projectGid),
          projectName: str(a.projectName),
          assigneeGid: gid(a.assigneeGid),
          assigneeName: str(a.assigneeName),
        }
      : { ...EMPTY_ASANA },
  };
}

async function getConfig() {
  const { rows } = await db.query(`SELECT value FROM platform_settings WHERE key = $1`, [KEY]);
  return normalize(rows[0]?.value);
}

// Merges a partial update (omitted = keep) and validates field by field. `asanaProbe(workspaceGid)` is supplied by the
// caller and must throw if the saving admin's Asana account cannot see that workspace.
async function updateConfig(userId, input = {}, { verifyWorkspace } = {}) {
  const current = await getConfig();
  const next = { ...current, transcription: { ...current.transcription }, asana: { ...current.asana } };

  if (input.s3Prefix !== undefined) {
    const p = String(input.s3Prefix || "").trim();
    if (p && !PREFIX.test(p)) throw httpError("The storage folder can only use letters, numbers, / _ and -.", 400);
    next.s3Prefix = p;
  }
  if (input.maxHeight !== undefined) {
    if (!HEIGHTS.includes(Number(input.maxHeight))) throw httpError("Pick a recording quality of 360p, 480p or 720p.", 400);
    next.maxHeight = Number(input.maxHeight);
  }
  if (input.maxDurationSeconds !== undefined) {
    const d = Number(input.maxDurationSeconds);
    if (!Number.isFinite(d) || d < 30 || d > 1800) throw httpError("The recording length must be between 30 seconds and 30 minutes.", 400);
    next.maxDurationSeconds = Math.round(d);
  }
  if (input.transcription?.provider !== undefined) {
    if (!PROVIDERS.includes(input.transcription.provider)) throw httpError("That transcription option is not available.", 400);
    next.transcription.provider = input.transcription.provider;
  }

  if (input.asana !== undefined) {
    const a = input.asana || {};
    if (a.workspaceGid === null) {
      next.asana = { ...EMPTY_ASANA };
    } else {
      if (a.workspaceGid !== undefined) {
        if (!GID.test(String(a.workspaceGid))) throw httpError("That Asana workspace is not valid.", 400);
        if (a.workspaceGid !== current.asana.workspaceGid) {
          if (verifyWorkspace) await verifyWorkspace(a.workspaceGid);
          // Changing workspace resets project and assignee: they belong to the old one.
          next.asana = { ...EMPTY_ASANA, workspaceGid: a.workspaceGid, workspaceName: str(a.workspaceName) };
        }
        next.asana.connectionUserId = userId;
      }
      const needsWorkspace = a.projectGid !== undefined || a.assigneeGid !== undefined;
      if (needsWorkspace && !next.asana.workspaceGid) throw httpError("Pick an Asana workspace first.", 400);
      if (a.projectGid !== undefined) {
        if (a.projectGid !== null && !GID.test(String(a.projectGid))) throw httpError("That Asana project is not valid.", 400);
        next.asana.projectGid = a.projectGid;
        next.asana.projectName = a.projectGid ? str(a.projectName) : null;
      }
      if (a.assigneeGid !== undefined) {
        if (a.assigneeGid !== null && !GID.test(String(a.assigneeGid))) throw httpError("That Asana person is not valid.", 400);
        next.asana.assigneeGid = a.assigneeGid;
        next.asana.assigneeName = a.assigneeGid ? str(a.assigneeName) : null;
      }
    }
  }

  const clean = normalize(next);
  await db.query(
    `INSERT INTO platform_settings (key, value, updated_by, updated_at) VALUES ($1, $2::jsonb, $3, NOW())
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_by = EXCLUDED.updated_by, updated_at = NOW()`,
    [KEY, JSON.stringify(clean), userId],
  );
  return clean;
}

module.exports = { getConfig, updateConfig, normalize, MAX_VIDEO_BYTES, MAX_AUDIO_BYTES, HEIGHTS };
