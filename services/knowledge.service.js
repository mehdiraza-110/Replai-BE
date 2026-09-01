const db = require("../config/db.config");
const mammoth = require("mammoth");
const { saveFileToDisk } = require("../config/multer.config");
const eventLogService = require("./eventLog.service");

const allowedStatuses = new Set(["Published", "Review", "Draft"]);
const allowedSourceTypes = new Set(["Text", "Document", "URL", "FAQ"]);

class KnowledgeService {
  async ensureSchema() {
    await db.query(`
      CREATE TABLE IF NOT EXISTS knowledge_sources (
        id SERIAL PRIMARY KEY,
        title VARCHAR(240) NOT NULL,
        category VARCHAR(160),
        source_type VARCHAR(40) NOT NULL DEFAULT 'Text' CHECK (source_type IN ('Text', 'Document', 'URL', 'FAQ')),
        owner VARCHAR(180),
        status VARCHAR(40) NOT NULL DEFAULT 'Review' CHECK (status IN ('Published', 'Review', 'Draft')),
        content_text TEXT,
        usage_guidance TEXT,
        source_url VARCHAR(700),
        file_name VARCHAR(350),
        file_mime_type VARCHAR(180),
        file_size BIGINT,
        file_storage_path VARCHAR(700),
        chunks_count INT NOT NULL DEFAULT 0,
        last_indexed_at TIMESTAMP,
        created_by INT REFERENCES users(id) ON DELETE SET NULL,
        created_at TIMESTAMP NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMP NOT NULL DEFAULT NOW(),
        is_deleted BOOLEAN NOT NULL DEFAULT FALSE
      )
    `);
    await db.query(`
      CREATE TABLE IF NOT EXISTS ai_agent_knowledge_sources (
        ai_agent_id INT REFERENCES ai_agents(id) ON DELETE CASCADE,
        knowledge_source_id INT REFERENCES knowledge_sources(id) ON DELETE CASCADE,
        created_at TIMESTAMP NOT NULL DEFAULT NOW(),
        PRIMARY KEY (ai_agent_id, knowledge_source_id)
      )
    `);
  }

  async list(query = {}) {
    await this.ensureSchema();

    const page = Math.max(1, Number.parseInt(query.page, 10) || 1);
    const limit = Math.min(Math.max(Number.parseInt(query.limit, 10) || 25, 1), 100);
    const offset = (page - 1) * limit;
    const search = cleanString(query.search);
    const status = normalizeStatus(query.status, { allowEmpty: true });
    const category = cleanString(query.category);
    const values = [];
    const filters = ["ks.is_deleted = FALSE"];

    if (search) {
      values.push(`%${search}%`);
      filters.push(`(ks.title ILIKE $${values.length} OR ks.category ILIKE $${values.length} OR ks.content_text ILIKE $${values.length})`);
    }

    if (status) {
      values.push(status);
      filters.push(`ks.status = $${values.length}`);
    }

    if (category) {
      values.push(category);
      filters.push(`ks.category = $${values.length}`);
    }

    const where = filters.join(" AND ");
    const [items, total] = await Promise.all([
      db.query(
        `SELECT ks.*,
                COALESCE(
                  json_agg(
                    json_build_object('id', a.id, 'name', a.name)
                    ORDER BY a.name
                  ) FILTER (WHERE a.id IS NOT NULL),
                  '[]'::json
                ) AS agents
         FROM knowledge_sources ks
         LEFT JOIN ai_agent_knowledge_sources aks ON aks.knowledge_source_id = ks.id
         LEFT JOIN ai_agents a ON a.id = aks.ai_agent_id AND a.is_deleted = FALSE
         WHERE ${where}
         GROUP BY ks.id
         ORDER BY ks.updated_at DESC
         LIMIT $${values.length + 1} OFFSET $${values.length + 2}`,
        [...values, limit, offset]
      ),
      db.query(`SELECT COUNT(*)::int AS count FROM knowledge_sources ks WHERE ${where}`, values),
    ]);

    return {
      items: items.rows.map(mapKnowledgeRow),
      page,
      limit,
      total: total.rows[0]?.count || 0,
      totalPages: Math.max(1, Math.ceil((total.rows[0]?.count || 0) / limit)),
    };
  }

  async create(payload = {}, file, userId = null) {
    await this.ensureSchema();

    const startedAt = Date.now();
    const extractedText = file ? await extractTextFromFile(file) : null;
    const filePath = file ? saveFileToDisk(file) : null;
    const sourceType = normalizeSourceType(payload.sourceType || payload.source_type || (file ? "Document" : "Text"));
    const contentText = cleanString(payload.contentText || payload.content_text) || extractedText;
    const chunksCount = chunkKnowledgeText(contentText).length;
    const agentIds = normalizeIds(payload.agentIds || payload.agent_ids);
    const title = cleanString(payload.title) || file?.originalname;

    if (!title) {
      const error = new Error("Knowledge title is required");
      error.statusCode = 400;
      throw error;
    }

    const result = await db.query(
      `INSERT INTO knowledge_sources (
        title,
        category,
        source_type,
        owner,
        status,
        content_text,
        usage_guidance,
        source_url,
        file_name,
        file_mime_type,
        file_size,
        file_storage_path,
        chunks_count,
        last_indexed_at,
        created_by
      )
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, CASE WHEN $13 > 0 THEN NOW() ELSE NULL END, $14)
      RETURNING *`,
      [
        title,
        cleanString(payload.category),
        sourceType,
        cleanString(payload.owner),
        normalizeStatus(payload.status),
        contentText,
        cleanString(payload.usageGuidance || payload.usage_guidance),
        cleanString(payload.sourceUrl || payload.source_url),
        file?.originalname || null,
        file?.mimetype || null,
        file?.size || null,
        filePath,
        chunksCount,
        userId,
      ]
    );

    await this.setSourceAgents(result.rows[0].id, agentIds);

    const source = await this.getById(result.rows[0].id);
    await eventLogService.record({
      eventType: "knowledge_source.created",
      source: "knowledge",
      status: "Success",
      durationMs: Date.now() - startedAt,
      createdBy: userId,
      metadata: {
        title: source.title,
        sourceType,
        status: source.status,
        chunks: source.chunks,
        fileName: source.fileName,
        assignedAgents: source.agents.length,
      },
    });

    return source;
  }

  async delete(sourceId) {
    await this.ensureSchema();

    const result = await db.query(
      `UPDATE knowledge_sources
       SET is_deleted = TRUE,
           updated_at = NOW()
       WHERE id = $1 AND is_deleted = FALSE
       RETURNING id, title`,
      [sourceId]
    );

    if (result.rows.length === 0) {
      const error = new Error("Knowledge source not found");
      error.statusCode = 404;
      throw error;
    }

    await eventLogService.record({
      eventType: "knowledge_source.deleted",
      source: "knowledge",
      status: "Success",
      metadata: { id: result.rows[0].id, title: result.rows[0].title },
    });

    return { id: result.rows[0].id };
  }

  async setAgentSources(agentId, sourceIds = []) {
    await this.ensureSchema();

    await db.query("DELETE FROM ai_agent_knowledge_sources WHERE ai_agent_id = $1", [agentId]);

    const ids = normalizeIds(sourceIds);
    if (ids.length === 0) return;

    const values = [];
    const placeholders = ids.map((sourceId, index) => {
      values.push(agentId, sourceId);
      const offset = index * 2;
      return `($${offset + 1}, $${offset + 2})`;
    });

    await db.query(
      `INSERT INTO ai_agent_knowledge_sources (ai_agent_id, knowledge_source_id)
       VALUES ${placeholders.join(", ")}
       ON CONFLICT DO NOTHING`,
      values
    );
  }

  async getAgentSourceIds(agentId) {
    await this.ensureSchema();

    const result = await db.query(
      `SELECT knowledge_source_id
       FROM ai_agent_knowledge_sources
       WHERE ai_agent_id = $1`,
      [agentId]
    );

    return result.rows.map((row) => row.knowledge_source_id);
  }

  async getAgentKnowledgeContext(agentId) {
    await this.ensureSchema();
    if (!agentId) return [];

    const result = await db.query(
      `SELECT ks.*
       FROM ai_agent_knowledge_sources aks
       JOIN knowledge_sources ks ON ks.id = aks.knowledge_source_id
       WHERE aks.ai_agent_id = $1
         AND ks.is_deleted = FALSE
         AND ks.status = 'Published'
       ORDER BY ks.updated_at DESC
       LIMIT 12`,
      [agentId]
    );

    return result.rows.map((row) => ({
      title: row.title,
      category: row.category,
      usageGuidance: row.usage_guidance,
      snippets: chunkKnowledgeText(row.content_text).slice(0, 4),
    }));
  }

  async getById(sourceId) {
    const result = await db.query(
      `SELECT ks.*,
              COALESCE(
                json_agg(
                  json_build_object('id', a.id, 'name', a.name)
                  ORDER BY a.name
                ) FILTER (WHERE a.id IS NOT NULL),
                '[]'::json
              ) AS agents
       FROM knowledge_sources ks
       LEFT JOIN ai_agent_knowledge_sources aks ON aks.knowledge_source_id = ks.id
       LEFT JOIN ai_agents a ON a.id = aks.ai_agent_id AND a.is_deleted = FALSE
       WHERE ks.id = $1 AND ks.is_deleted = FALSE
       GROUP BY ks.id`,
      [sourceId]
    );

    return result.rows[0] ? mapKnowledgeRow(result.rows[0]) : null;
  }

  async setSourceAgents(sourceId, agentIds = []) {
    const ids = normalizeIds(agentIds);

    if (ids.length === 0) return;

    const values = [];
    const placeholders = ids.map((agentId, index) => {
      values.push(agentId, sourceId);
      const offset = index * 2;
      return `($${offset + 1}, $${offset + 2})`;
    });

    await db.query(
      `INSERT INTO ai_agent_knowledge_sources (ai_agent_id, knowledge_source_id)
       VALUES ${placeholders.join(", ")}
       ON CONFLICT DO NOTHING`,
      values
    );
  }
}

function mapKnowledgeRow(row) {
  return {
    id: row.id,
    title: row.title,
    category: row.category || "General",
    sourceType: row.source_type,
    owner: row.owner || "Unassigned",
    status: row.status,
    contentText: row.content_text,
    usageGuidance: row.usage_guidance,
    sourceUrl: row.source_url,
    fileName: row.file_name,
    fileMimeType: row.file_mime_type,
    fileSize: row.file_size ? Number(row.file_size) : null,
    fileStoragePath: row.file_storage_path,
    chunks: Number(row.chunks_count || 0),
    agents: Array.isArray(row.agents) ? row.agents : [],
    lastIndexedAt: row.last_indexed_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

async function extractTextFromFile(file) {
  const extension = String(file.originalname || "").split(".").pop()?.toLowerCase();
  const mimetype = String(file.mimetype || "").toLowerCase();

  if (
    mimetype.startsWith("text/") ||
    ["txt", "md", "markdown", "csv", "json", "html", "htm"].includes(extension)
  ) {
    return cleanString(file.buffer.toString("utf8"));
  }

  if (mimetype === "application/pdf" || extension === "pdf") {
    // Required lazily: pdf-parse pulls in pdfjs-dist + a native canvas addon,
    // which can fail to load on some Node/OS builds. Loading it only when a
    // PDF is actually uploaded means that failure just disables PDF text
    // extraction for this file instead of crashing the whole server on boot.
    try {
      const pdfParse = require("pdf-parse");
      const result = await pdfParse(file.buffer);
      return cleanString(result.text);
    } catch (error) {
      console.error("PDF text extraction failed:", error.message);
      return null;
    }
  }

  if (
    mimetype === "application/vnd.openxmlformats-officedocument.wordprocessingml.document" ||
    extension === "docx"
  ) {
    try {
      const result = await mammoth.extractRawText({ buffer: file.buffer });
      return cleanString(result.value);
    } catch {
      return null;
    }
  }

  return null;
}

function chunkKnowledgeText(value) {
  const text = cleanString(value);
  if (!text) return [];

  const normalized = text.replace(/\r\n/g, "\n").replace(/\n{3,}/g, "\n\n");
  const chunks = [];
  let cursor = 0;

  while (cursor < normalized.length) {
    const next = normalized.slice(cursor, cursor + 1200);
    chunks.push(next.trim());
    cursor += 1200;
  }

  return chunks.filter(Boolean);
}

function normalizeIds(value) {
  if (value === undefined || value === null || value === "") return [];

  const raw = Array.isArray(value) ? value : String(value).split(",");
  return [...new Set(raw.map((item) => Number(item)).filter((item) => Number.isInteger(item) && item > 0))];
}

function normalizeStatus(value, options = {}) {
  const status = cleanString(value);
  if (!status && options.allowEmpty) return null;
  if (!status) return "Review";

  return [...allowedStatuses].find((allowedStatus) => allowedStatus.toLowerCase() === status.toLowerCase()) || "Review";
}

function normalizeSourceType(value) {
  const sourceType = cleanString(value) || "Text";
  return [...allowedSourceTypes].find((allowedType) => allowedType.toLowerCase() === sourceType.toLowerCase()) || "Text";
}

function cleanString(value) {
  if (value === undefined) return undefined;
  if (value === null) return null;

  const text = String(value).trim();
  return text.length > 0 ? text : null;
}

module.exports = new KnowledgeService();
