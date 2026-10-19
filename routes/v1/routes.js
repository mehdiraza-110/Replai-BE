const express = require('express');
const router = express.Router();
const userRoutes = require('./user.routes');
const aiModelRoutes = require('./ai-model.routes');
const aiAgentRoutes = require('./ai-agent.routes');
const plusVibeRoutes = require('./plus-vibe.routes');
const messageRoutes = require('./message.routes');
const eventLogRoutes = require('./event-log.routes');
const leadRoutes = require('./lead.routes');
const analyticsRoutes = require('./analytics.routes');
const reviewRoutes = require('./review.routes');
const knowledgeRoutes = require('./knowledge.routes');
const notificationRoutes = require('./notification.routes');
const ghlRoutes = require('./ghl.routes');
const forwardedLeadRoutes = require('./forwarded-lead.routes');
const calendarRoutes = require('./calendar.routes');
const domainRoutes = require('./domain.routes');
const mailboxRoutes = require('./mailbox.routes');
const warmupRoutes = require('./warmup.routes');
const campaignRoutes = require('./campaign.routes');
const inboxRoutes = require('./inbox.routes');
const warmupPoolRoutes = require('./warmup-pool.routes');
const unsubscribeRoutes = require('./unsubscribe.routes');
const suppressionRoutes = require('./suppression.routes');
const sesInboundRoutes = require('./ses-inbound.routes');
const sesEventsRoutes = require('./ses-events.routes');
const postalRoutes = require('./postal.routes');
const workspaceRoutes = require('./workspace.routes');
const aiKeyRoutes = require('./ai-keys.routes');
const adminRoutes = require('./admin.routes');
const memberRoutes = require('./members.routes');
const workflowRoutes = require('./workflows.routes');

// User + workspace routes guard themselves (signup/login are public; everything else is per-route).
router.use('/users', userRoutes);
router.use('/workspaces', workspaceRoutes);

// Everything below is tenant data: the caller must be signed in and acting inside a workspace, and services
// must filter by req.workspaceId. Only endpoints with their own secret or no browser session are left public.
const { TenantGuard, tenantGuardExcept, requireProduct } = require('../../middlewares/tenant.middleware');
const coldMailer = requireProduct('cold_mailer');
const autoResponder = requireProduct('auto_responder');

// Shared across products
router.use('/ai-models', TenantGuard, aiModelRoutes);
router.use('/ai-agents', TenantGuard, aiAgentRoutes);
router.use('/messages', TenantGuard, messageRoutes);
router.use('/event-logs', TenantGuard, eventLogRoutes);
router.use('/leads', TenantGuard, leadRoutes);
router.use('/analytics', TenantGuard, analyticsRoutes);
router.use('/knowledge', TenantGuard, knowledgeRoutes);
router.use('/notifications', TenantGuard, notificationRoutes);
router.use('/calendar', tenantGuardExcept('GET /google/callback'), calendarRoutes); // callback is verified via signed OAuth state
router.use('/domains', TenantGuard, domainRoutes);
router.use('/mailboxes', TenantGuard, mailboxRoutes);

// Auto responder
router.use('/plusvibe', tenantGuardExcept('POST /webhook'), (req, res, next) => (req.path === '/webhook' ? next() : autoResponder(req, res, next)), plusVibeRoutes);
router.use('/ghl', TenantGuard, autoResponder, ghlRoutes);
router.use('/reviews', TenantGuard, autoResponder, reviewRoutes);
router.use('/forwarded-leads', TenantGuard, autoResponder, forwardedLeadRoutes);

// Cold mailer
router.use('/warmup', TenantGuard, coldMailer, warmupRoutes);
router.use('/campaigns', TenantGuard, coldMailer, campaignRoutes);
router.use('/suppressions', TenantGuard, coldMailer, suppressionRoutes);
router.use('/mailer-inbox', TenantGuard, coldMailer, inboxRoutes);
router.use('/warmup-pool', TenantGuard, coldMailer, warmupPoolRoutes);

// Workspace management (owner/admin checks live in the controllers), AI keys, automation workflows
router.use('/members', TenantGuard, memberRoutes);
router.use('/ai-keys', TenantGuard, aiKeyRoutes);
router.use('/workflows', TenantGuard, workflowRoutes);

// Platform administration: super admin only, no workspace needed
router.use('/admin', require('../../middlewares/superAdmin.middleware'), adminRoutes);

// Public by design: unsubscribe links (signed token) and provider webhooks (own secret / signature).
router.use('/unsubscribe', unsubscribeRoutes);
router.use('/ses-inbound', sesInboundRoutes);
router.use('/ses-events', sesEventsRoutes);
router.use('/postal', postalRoutes);


module.exports = router;
