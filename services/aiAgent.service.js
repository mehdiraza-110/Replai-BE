const db = require("../config/db.config");
const eventLogService = require("./eventLog.service");

const insertFields = [
  "name",
  "description",
  "role",
  "persona",
  "tone",
  "response_style",
  "company_name",
  "website",
  "industry",
  "value_proposition",
  "objective",
  "success_criteria",
  "language",
  "auto_detect_language",
  "response_rules",
  "sales_rules",
  "safety_rules",
  "knowledge_sources",
  "training_examples",
  "ai_provider",
  "ai_model",
  "automation_mode",
  "confidence_threshold",
  "require_human_review",
  "auto_reply_enabled",
  "assigned_inbox_name",
  "assigned_workspace_name",
  "status",
  "created_by",
];

const updateFields = insertFields.filter((field) => field !== "created_by");

class AiAgentService {
  async listAgents() {
    const result = await db.query(
      `SELECT *
       FROM ai_agents
       WHERE is_deleted = FALSE
       ORDER BY updated_at DESC`
    );

    return result.rows.map(mapAgentRow);
  }

  async getAgentById(agentId) {
    const result = await db.query(
      `SELECT *
       FROM ai_agents
       WHERE id = $1 AND is_deleted = FALSE`,
      [agentId]
    );

    return result.rows[0] ? mapAgentRow(result.rows[0]) : null;
  }

  async createAgent(agentData) {
    const startedAt = Date.now();
    const normalized = normalizeAgentPayload(agentData);
    validateAgent(normalized);

    const values = insertFields.map((field) => normalized[field] ?? null);
    const placeholders = insertFields.map((_, index) => `$${index + 1}`).join(", ");

    const result = await db.query(
      `INSERT INTO ai_agents (${insertFields.join(", ")})
       VALUES (${placeholders})
       RETURNING *`,
      values
    );

    const agent = mapAgentRow(result.rows[0]);
    await eventLogService.record({
      eventType: "ai_agent.created",
      source: "ai",
      status: "Success",
      aiAgentId: agent.id,
      aiAgentName: agent.name,
      durationMs: Date.now() - startedAt,
      createdBy: agent.createdBy,
      metadata: {
        role: agent.role,
        model: agent.model,
        automationMode: agent.automationMode,
        autoReply: agent.autoReply,
      },
    });

    return agent;
  }

  async updateAgent(agentId, agentData) {
    const startedAt = Date.now();
    const normalized = normalizeAgentPayload(agentData, { partial: true });
    const assignments = [];
    const values = [];

    updateFields.forEach((field) => {
      if (normalized[field] !== undefined) {
        values.push(normalized[field]);
        assignments.push(`${field} = $${values.length}`);
      }
    });

    if (assignments.length === 0) {
      const error = new Error("No fields to update");
      error.statusCode = 400;
      throw error;
    }

    values.push(agentId);
    const result = await db.query(
      `UPDATE ai_agents
       SET ${assignments.join(", ")}, updated_at = NOW()
       WHERE id = $${values.length} AND is_deleted = FALSE
       RETURNING *`,
      values
    );

    if (result.rows.length === 0) {
      const error = new Error("AI agent not found");
      error.statusCode = 404;
      throw error;
    }

    const agent = mapAgentRow(result.rows[0]);
    await eventLogService.record({
      eventType: "ai_agent.updated",
      source: "ai",
      status: "Success",
      aiAgentId: agent.id,
      aiAgentName: agent.name,
      durationMs: Date.now() - startedAt,
      metadata: {
        changedFields: assignments.map((assignment) => assignment.split(" = ")[0]),
        status: agent.status,
        model: agent.model,
      },
    });

    return agent;
  }

  async deleteAgent(agentId) {
    const startedAt = Date.now();
    const result = await db.query(
      `UPDATE ai_agents
       SET is_deleted = TRUE, updated_at = NOW()
       WHERE id = $1 AND is_deleted = FALSE
       RETURNING id, name`,
      [agentId]
    );

    if (result.rows.length === 0) {
      const error = new Error("AI agent not found");
      error.statusCode = 404;
      throw error;
    }

    await eventLogService.record({
      eventType: "ai_agent.deleted",
      source: "ai",
      status: "Success",
      aiAgentId: result.rows[0].id,
      aiAgentName: result.rows[0].name,
      durationMs: Date.now() - startedAt,
    });

    return { id: result.rows[0].id };
  }
}

function normalizeAgentPayload(payload, options = {}) {
  const requireDefaults = !options.partial;

  return {
    name: cleanString(payload.name),
    description: cleanString(payload.description),
    role: cleanString(payload.role),
    persona: cleanString(payload.persona),
    tone: cleanString(payload.tone) || (requireDefaults ? "Consultative" : undefined),
    response_style: cleanString(payload.response_style ?? payload.responseStyle) || (requireDefaults ? "Concise" : undefined),
    company_name: cleanString(payload.company_name ?? payload.companyName),
    website: cleanString(payload.website),
    industry: cleanString(payload.industry),
    value_proposition: cleanString(payload.value_proposition ?? payload.valueProposition),
    objective: cleanString(payload.objective),
    success_criteria: cleanString(payload.success_criteria ?? payload.successCriteria),
    language: cleanString(payload.language) || (requireDefaults ? "English" : undefined),
    auto_detect_language: normalizeBoolean(payload.auto_detect_language ?? payload.autoDetectLanguage, requireDefaults ? true : undefined),
    response_rules: cleanString(payload.response_rules ?? payload.responseRules),
    sales_rules: cleanString(payload.sales_rules ?? payload.salesRules),
    safety_rules: cleanString(payload.safety_rules ?? payload.safetyRules),
    knowledge_sources: cleanString(payload.knowledge_sources ?? payload.knowledgeSources),
    training_examples: cleanString(payload.training_examples ?? payload.trainingExamples),
    ai_provider: cleanString(payload.ai_provider ?? payload.aiProvider),
    ai_model: cleanString(payload.ai_model ?? payload.model ?? payload.aiModel),
    automation_mode: cleanString(payload.automation_mode ?? payload.automationMode) || (requireDefaults ? "AI + Approval" : undefined),
    confidence_threshold: normalizeThreshold(payload.confidence_threshold ?? payload.confidenceThreshold),
    require_human_review: normalizeBoolean(payload.require_human_review ?? payload.humanReview ?? payload.requireHumanReview, requireDefaults ? true : undefined),
    auto_reply_enabled: normalizeBoolean(payload.auto_reply_enabled ?? payload.autoReplyEnabled, requireDefaults ? false : undefined),
    assigned_inbox_name: cleanString(payload.assigned_inbox_name ?? payload.assignedInboxName),
    assigned_workspace_name: cleanString(payload.assigned_workspace_name ?? payload.assignedWorkspaceName),
    status: cleanString(payload.status) || (requireDefaults ? "Active" : undefined),
    created_by: payload.created_by ?? payload.createdBy ?? null,
  };
}

function validateAgent(agent) {
  const requiredFields = [
    ["name", "Agent name is required"],
    ["role", "Agent role is required"],
    ["persona", "Persona is required"],
    ["company_name", "Company name is required"],
    ["objective", "Objective is required"],
    ["language", "Language is required"],
    ["ai_provider", "AI provider is required"],
    ["ai_model", "AI model is required"],
    ["automation_mode", "Automation mode is required"],
  ];

  const missing = requiredFields.find(([field]) => !agent[field]);
  if (missing) {
    const error = new Error(missing[1]);
    error.statusCode = 400;
    throw error;
  }
}

function cleanString(value) {
  if (value === undefined) return undefined;
  if (value === null) return null;

  const text = String(value).trim();
  return text.length > 0 ? text : null;
}

function normalizeBoolean(value, fallback) {
  if (value === undefined || value === null || value === "") return fallback;
  return Boolean(value);
}

function normalizeThreshold(value) {
  if (value === undefined || value === null || value === "") return undefined;

  const numberValue = Number(value);
  if (!Number.isFinite(numberValue) || numberValue < 0 || numberValue > 100) {
    const error = new Error("Confidence threshold must be between 0 and 100");
    error.statusCode = 400;
    throw error;
  }

  return numberValue;
}

function mapAgentRow(row) {
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    role: row.role,
    persona: row.persona,
    tone: row.tone,
    responseStyle: row.response_style,
    companyName: row.company_name,
    website: row.website,
    industry: row.industry,
    valueProposition: row.value_proposition,
    objective: row.objective,
    successCriteria: row.success_criteria,
    language: row.language,
    autoDetectLanguage: row.auto_detect_language,
    responseRules: row.response_rules,
    salesRules: row.sales_rules,
    safetyRules: row.safety_rules,
    knowledgeSources: row.knowledge_sources,
    trainingExamples: row.training_examples,
    aiProvider: row.ai_provider,
    model: row.ai_model,
    automationMode: row.automation_mode,
    confidenceThreshold: Number(row.confidence_threshold),
    humanReview: row.require_human_review,
    autoReply: row.auto_reply_enabled,
    inbox: row.assigned_inbox_name,
    workspace: row.assigned_workspace_name,
    status: row.status,
    createdBy: row.created_by,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

module.exports = new AiAgentService();
