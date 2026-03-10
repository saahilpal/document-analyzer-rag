const express = require('express');
const { getJobStatus } = require('../../../controllers/jobController');
const requireAuth = require('../../../middleware/requireAuth');
const asyncHandler = require('../../../utils/asyncHandler');
const { strictReadLimiter } = require('../../../middleware/limiters');

const router = express.Router();

router.use(requireAuth);
router.get('/:jobId', strictReadLimiter, asyncHandler(getJobStatus));

module.exports = router;
