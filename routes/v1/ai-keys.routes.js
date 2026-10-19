const express = require('express');
const aiKeyController = require('../../controllers/aiKey.controller');

const router = express.Router();

// Mounted at /ai-keys behind TenantGuard. Writes are restricted to owner/admin inside the controller.
router.get('/', aiKeyController.list);
router.put('/:provider', aiKeyController.save);
router.delete('/:provider', aiKeyController.remove);
router.post('/:provider/test', aiKeyController.test);

module.exports = router;
