const express = require('express');
const router = express.Router();
const userRoutes = require('./user.routes');

// User routes
router.use('/users', userRoutes);


module.exports = router;
