const { getJobForUser, getQueuePosition } = require('../services/jobQueue');
const { createHttpError } = require('../utils/errors');
const { ok, fail } = require('../routes/helpers');

async function getJobStatus(req, res) {
    const job = getJobForUser(req.params.jobId, req.user.id);
    if (!job) {
        return fail(res, createHttpError(404, 'NOT_FOUND', 'Job not found.'), 404);
    }

    const response = {
        id: job.id,
        type: job.type,
        status: job.status,
        progress: job.progress,
        stage: job.stage,
        createdAt: job.createdAt,
        updatedAt: job.updatedAt,
    };

    response.queuePosition = (job.status === 'pending' || job.status === 'processing')
        ? getQueuePosition(job.id)
        : 0;

    if (job.status === 'completed' && job.result) {
        try {
            response.result = JSON.parse(job.result);
        } catch {
            response.result = job.result;
        }
    }

    if (job.status === 'failed' && job.error) {
        response.error = job.error;
    }

    return ok(res, response);
}

module.exports = {
    getJobStatus
};
