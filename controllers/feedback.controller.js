const feedback = require('../services/feedback.service');
const settings = require('../services/feedbackSettings.service');
const asana = require('../services/asana.service');

const handle = (fallback, status, fn) => async (req, res) => {
  try {
    const data = await fn(req);
    res.status(status).json({ success: true, ...(data === undefined ? {} : { data }) });
  } catch (error) {
    const code = error.statusCode || 500;
    if (code >= 500) console.error(fallback, error);
    res.status(code).json({ success: false, message: code >= 500 ? fallback : error.message, ...(error.code ? { code: error.code } : {}) });
  }
};

const actor = (req) => req.ticketUser;
const GENERIC = 'Something went wrong with that ticket. Please try again.';

module.exports = {
  create: handle(GENERIC, 201, (req) => feedback.create(actor(req), req.body || {}).then((f) => ({ feedback: f }))),
  config: handle(GENERIC, 200, () => feedback.publicConfig()),
  mine: handle(GENERIC, 200, (req) => feedback.listMine(actor(req)).then((items) => ({ items }))),
  mineUnread: handle(GENERIC, 200, (req) => feedback.unreadCount(actor(req))),
  inbox: handle(GENERIC, 200, (req) => feedback.inbox(req.query)),
  newForStaff: handle(GENERIC, 200, (req) => feedback.newForStaff(actor(req), req.query.since)),
  thread: handle(GENERIC, 200, (req) => feedback.thread(actor(req), req.params.id)),
  reply: handle(GENERIC, 201, (req) => feedback.addReply(actor(req), req.params.id, req.body?.body).then((reply) => ({ reply }))),
  status: handle(GENERIC, 200, (req) => feedback.setStatus(actor(req), req.params.id, req.body?.status, req.body?.message)),
  recording: handle('We could not save the recording. Please try again.', 200, (req) => feedback.saveRecording(actor(req), req.params.id, req)),
  transcript: handle(GENERIC, 200, (req) => feedback.saveTranscript(actor(req), req.params.id, req)),
  transcribe: handle('We could not transcribe that audio. Please try again.', 200, (req) => feedback.transcribeOnly(req)),
  asanaTask: handle(GENERIC, 200, (req) => feedback.createAsanaTask(actor(req), req.params.id)),
  recordingUrl: handle(GENERIC, 200, (req) => feedback.recordingUrl(actor(req), req.params.id, req.query.download === '1')),

  getSettings: handle(GENERIC, 200, async () => ({ config: await settings.getConfig() })),
  putSettings: handle('We could not save the ticket settings.', 200, async (req) => ({
    config: await settings.updateConfig(actor(req).id, req.body || {}, { verifyWorkspace: (gid) => asana.assertWorkspaceReachable(actor(req).id, gid) }),
  })),

  asanaStatus: handle(GENERIC, 200, (req) => asana.status(actor(req).id)),
  asanaConnect: handle('We could not connect to Asana.', 201, (req) => asana.connect(actor(req).id, req.body?.token)),
  asanaTest: handle('We could not check that connection.', 200, (req) => asana.test(actor(req).id, req.params.id)),
  asanaDisconnect: handle('We could not remove that connection.', 200, (req) => asana.disconnect(actor(req).id, req.params.id)),
  asanaWorkspaces: handle('We could not load your Asana workspaces.', 200, async (req) => ({ items: await asana.workspaces(actor(req).id) })),
  asanaProjects: handle('We could not load that workspace\'s projects.', 200, async (req) => ({ items: await asana.projects(actor(req).id, String(req.query.workspaceGid || '')) })),
  asanaUsers: handle('We could not load that workspace\'s people.', 200, async (req) => ({ items: await asana.users(actor(req).id, String(req.query.workspaceGid || '')) })),
};
