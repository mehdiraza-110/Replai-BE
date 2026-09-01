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


module.exports = router;
