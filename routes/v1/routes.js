const express = require('express');
const router = express.Router();
const userRoutes = require('./user.routes');
const plusvibeRoutes = require('./plusvibe.routes');

// User routes
router.use('/users', userRoutes);
router.use('/plusvibe', plusvibeRoutes);


module.exports = router;
