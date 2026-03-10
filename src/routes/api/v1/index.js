const express = require('express');
const os = require('os');
const { getQueueState } = require('../../../services/jobQueue');
const { strictReadLimiter } = require('../../../middleware/limiters');
const { ok } = require('../../helpers');

const authRoutes = require('./auth');
const sessionRoutes = require('./sessions');
const pdfRoutes = require('./pdfs');
const jobRoutes = require('./jobs');
const chatRoutes = require('./chat');

const router = express.Router();

// System Health
router.get('/health', strictReadLimiter, (req, res) => {
    const queueState = getQueueState();
    const memoryUsage = process.memoryUsage();
    const cpuLoad = os.loadavg();

    return ok(res, {
        status: 'ok',
        service: 'Document-analyzer-rag Backend',
        uptime: process.uptime(),
        queueSize: queueState.pending + queueState.processing,
        memoryUsage: {
            rss: memoryUsage.rss,
            heapTotal: memoryUsage.heapTotal,
            heapUsed: memoryUsage.heapUsed,
            external: memoryUsage.external,
        },
        cpuLoad: {
            oneMinute: cpuLoad[0],
            fiveMinutes: cpuLoad[1],
            fifteenMinutes: cpuLoad[2],
        },
    });
});

router.get('/ping', strictReadLimiter, (req, res) => ok(res, { pong: true }));

// Link modular routes
router.use('/auth', authRoutes);
router.use('/sessions', sessionRoutes);
router.use('/pdfs', pdfRoutes);
router.use('/jobs', jobRoutes);
router.use('/chat', chatRoutes);

module.exports = router;
