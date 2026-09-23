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
const unsubscribeRoutes = require('./unsubscribe.routes');
const suppressionRoutes = require('./suppression.routes');
const sesInboundRoutes = require('./ses-inbound.routes');

// User routes
router.use('/users', userRoutes);
router.use('/ai-models', aiModelRoutes);
router.use('/ai-agents', aiAgentRoutes);
router.use('/plusvibe', plusVibeRoutes);
router.use('/messages', messageRoutes);
router.use('/event-logs', eventLogRoutes);
router.use('/leads', leadRoutes);
router.use('/analytics', analyticsRoutes);
router.use('/reviews', reviewRoutes);
router.use('/knowledge', knowledgeRoutes);
router.use('/notifications', notificationRoutes);
router.use('/ghl', ghlRoutes);
router.use('/forwarded-leads', forwardedLeadRoutes);
router.use('/calendar', calendarRoutes);
router.use('/domains', domainRoutes);
router.use('/mailboxes', mailboxRoutes);
router.use('/warmup', warmupRoutes);
router.use('/campaigns', campaignRoutes);
router.use('/unsubscribe', unsubscribeRoutes);
router.use('/suppressions', suppressionRoutes);
router.use('/ses-inbound', sesInboundRoutes);


module.exports = router;
