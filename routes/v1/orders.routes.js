const express = require('express');
const router = express.Router();
const orders = require('../../controllers/order.controller');

// Tenant side of domain / mailbox ordering (request and approve). Mounted behind TenantGuard + the cold_mailer gate.
router.get('/', orders.list);
router.post('/', orders.create);
router.get('/:id', orders.get);
router.post('/:id/cancel', orders.cancel);

module.exports = router;
