const db = require("../../config/db.config");
const llm = require("./llm.service");
const { brainContext, bad, text } = require("./context");

const MAX_MESSAGE = 8000;
const HISTORY = 20;

const PERSONAS = {
  advisor: { name: "Growth Advisor", blurb: "Reliable business advice tailored to your growth goals.", prompt: "You are a growth advisor for small service businesses and agencies. You give practical, specific advice on offers, pricing, outbound and sales." },
  copywriter: { name: "Ad Copywriter", blurb: "Craft compelling ad copy for campaigns.", prompt: "You are a direct-response copywriter. You write ad copy, cold emails and landing page text. Give 2-3 distinct options when asked for copy." },
  researcher: { name: "Market Researcher", blurb: "Analyze markets and trends for your business.", prompt: "You are a market researcher. You analyze niches, buyers, competitors and trends. Be clear about what is general knowledge versus what the user should verify." },
  technical: { name: "Tech Wiz", blurb: "Technical help and automation solutions.", prompt: "You are a technical helper for email deliverability (SPF, DKIM, DMARC, warm-up, domains), automation and tooling. Give step-by-step answers." },
};

const SYSTEM_RULES = [
  "Answer in plain language. Use short paragraphs, and bullet or numbered lists when they help. You may use **bold** for key terms. No tables.",
  "Never invent statistics, client results, case studies or links. If you aren't sure, say so and say how to find out.",
  "Don't claim to have taken actions in the app (sent emails, changed settings). You can only advise and draft text.",
  "Ask one short clarifying question only if the request can't be answered usefully without it.",
].join("\n");

const mapThread = (r) => ({ id: Number(r.id), title: r.title, persona: r.persona, updatedAt: r.updated_at, createdAt: r.created_at });
const mapMessage = (r) => ({ id: Number(r.id), role: r.role, content: r.content, createdAt: r.created_at });
const personaList = () => Object.entries(PERSONAS).map(([id, p]) => ({ id, name: p.name, blurb: p.blurb }));

async function ownThread(workspaceId, userId, id) {
  if (!/^\d+$/.test(String(id))) throw bad("Chat not found.", 404);
  const { rows } = await db.query(`SELECT * FROM ai_chat_threads WHERE id = $1 AND workspace_id = $2 AND user_id = $3`, [id, workspaceId, userId]);
  if (!rows[0]) throw bad("Chat not found.", 404);
  return rows[0];
}

async function listThreads(workspaceId, userId) {
  const { rows } = await db.query(`SELECT * FROM ai_chat_threads WHERE workspace_id = $1 AND user_id = $2 ORDER BY updated_at DESC, id DESC LIMIT 100`, [workspaceId, userId]);
  return { personas: personaList(), threads: rows.map(mapThread) };
}

async function getThread(workspaceId, userId, id) {
  const thread = await ownThread(workspaceId, userId, id);
  const { rows } = await db.query(`SELECT * FROM ai_chat_messages WHERE thread_id = $1 ORDER BY id`, [thread.id]);
  return { ...mapThread(thread), messages: rows.map(mapMessage) };
}

async function deleteThread(workspaceId, userId, id) {
  const thread = await ownThread(workspaceId, userId, id);
  await db.query(`DELETE FROM ai_chat_threads WHERE id = $1`, [thread.id]);
  return { deleted: true };
}

/** Adds the user's message to a thread (creating it when threadId is empty), asks the model, stores and returns the reply. */
async function send(workspaceId, userId, { threadId, persona, message }) {
  const content = text(message, MAX_MESSAGE + 1);
  if (!content) throw bad("Type a message first.");
  if (content.length > MAX_MESSAGE) throw bad(`Messages can be up to ${MAX_MESSAGE.toLocaleString()} characters.`);
  const existing = threadId ? await ownThread(workspaceId, userId, threadId) : null;
  const personaKey = existing ? existing.persona : PERSONAS[persona] ? persona : "advisor";
  const past = existing ? (await db.query(`SELECT role, content FROM ai_chat_messages WHERE thread_id = $1 ORDER BY id DESC LIMIT $2`, [existing.id, HISTORY])).rows.reverse() : [];
  const messages = [...past, { role: "user", content }];
  // Providers want the conversation to start with a user turn and alternate; the stored history always does.
  while (messages.length && messages[0].role !== "user") messages.shift();

  const persona_ = PERSONAS[personaKey];
  const system = [persona_.prompt, SYSTEM_RULES, await brainContext(workspaceId)].filter(Boolean).join("\n\n");
  const reply = await llm.complete({ workspaceId, system, messages, action: "chat", maxTokens: 2048, temperature: 0.5 });

  // A new chat is only created once the model has answered, so a failed first message leaves no empty chat behind.
  const thread = existing || (await db.query(`INSERT INTO ai_chat_threads (workspace_id, user_id, title, persona) VALUES ($1,$2,$3,$4) RETURNING *`, [workspaceId, userId, content.replace(/\s+/g, " ").slice(0, 60), personaKey])).rows[0];
  let saved;
  try {
    saved = await db.query(`INSERT INTO ai_chat_messages (thread_id, role, content) VALUES ($1,'user',$2),($1,'assistant',$3) RETURNING *`, [thread.id, content, reply.text]);
  } catch (error) {
    // The chat was deleted (say, from another tab) while the answer was being written.
    if (error.code === "23503") throw bad("This chat was deleted while the answer was being written.", 409);
    throw error;
  }
  await db.query(`UPDATE ai_chat_threads SET updated_at = NOW() WHERE id = $1`, [thread.id]);
  return { thread: mapThread(thread), userMessage: mapMessage(saved.rows[0]), reply: mapMessage(saved.rows[1]) };
}

module.exports = { PERSONAS, listThreads, getThread, deleteThread, send };
