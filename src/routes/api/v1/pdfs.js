const express = require('express');
const { getPdf, deletePdf } = require('../../../controllers/pdfController');
const requireAuth = require('../../../middleware/requireAuth');
const asyncHandler = require('../../../utils/asyncHandler');
const { strictReadLimiter, writeLimiter } = require('../../../middleware/limiters');

const router = express.Router();

router.use(requireAuth);

router.get('/:pdfId', strictReadLimiter, asyncHandler(getPdf));
router.delete('/:pdfId', writeLimiter, asyncHandler(deletePdf));

module.exports = router;
