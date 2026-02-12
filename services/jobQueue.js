const { indexPdfById } = require('./indexingService');
const { runChatQuery } = require('./ragService');
const { addMessage } = require('./chatHistoryService');
const { touchSession } = require('./sessionService');
const { recordIndexing, recordQuery } = require('./metricsService');

const queue = [];
const jobs = new Map();
let running = false;
let sequence = 1;

function wait(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function createJobId() {
  const id = `job_${Date.now()}_${sequence}`;
  sequence += 1;
  return id;
}

function getJob(jobId) {
  return jobs.get(jobId) || null;
}

function getQueueState() {
  const pending = queue.length;
  const processing = Array.from(jobs.values()).filter((job) => job.status === 'processing').length;
  const completed = Array.from(jobs.values()).filter((job) => job.status === 'completed').length;
  const failed = Array.from(jobs.values()).filter((job) => job.status === 'failed').length;

  return {
    pending,
    processing,
    completed,
    failed,
    total: jobs.size,
  };
}

function addJob(payload) {
  const jobId = createJobId();
  const job = {
    id: jobId,
    type: payload.type,
    payload,
    status: 'queued',
    attempts: 0,
    maxRetries: payload.maxRetries || 2,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    result: null,
    error: null,
    metrics: null,
  };

  jobs.set(jobId, job);
  queue.push(jobId);
  processQueue().catch(() => {
    // processing errors are captured per job
  });

  return job;
}

async function runJob(job) {
  const startedAt = Date.now();

  if (job.type === 'indexPdf') {
    const result = await indexPdfById(job.payload.pdfId);
    recordIndexing({
      indexingTimeMs: result.indexingTimeMs || 0,
      embeddingTimeMs: result.embeddingTimeMs || 0,
    });
    return {
      ...result,
      indexingTimeMs: result.indexingTimeMs || Date.now() - startedAt,
    };
  }

  if (job.type === 'chatQuery') {
    const response = await runChatQuery(job.payload);
    recordQuery({ queryTimeMs: Date.now() - startedAt });
    addMessage({
      sessionId: job.payload.sessionId,
      role: 'user',
      text: job.payload.message,
    });
    addMessage({
      sessionId: job.payload.sessionId,
      role: 'assistant',
      text: response.answer,
      metadata: {
        sources: response.sources,
        usedChunksCount: response.usedChunksCount,
      },
    });
    touchSession(job.payload.sessionId);
    return response;
  }

  throw new Error(`Unsupported job type: ${job.type}`);
}

async function processQueue() {
  if (running) {
    return;
  }
  running = true;

  while (queue.length > 0) {
    const jobId = queue.shift();
    const job = jobs.get(jobId);
    if (!job) {
      continue;
    }

    job.status = 'processing';
    job.updatedAt = new Date().toISOString();
    job.attempts += 1;

    const startedAt = Date.now();

    try {
      const result = await runJob(job);
      job.status = 'completed';
      job.result = result;
      job.metrics = {
        durationMs: Date.now() - startedAt,
      };
      job.updatedAt = new Date().toISOString();
      // eslint-disable-next-line no-console
      console.info(`[jobQueue] job=${job.id} type=${job.type} status=completed durationMs=${job.metrics.durationMs}`);
    } catch (error) {
      job.error = error.message;
      job.updatedAt = new Date().toISOString();

      if (job.attempts <= job.maxRetries) {
        job.status = 'queued';
        const backoffMs = 250 * Math.pow(2, job.attempts - 1);
        // eslint-disable-next-line no-console
        console.warn(`[jobQueue] job=${job.id} retry=${job.attempts} backoffMs=${backoffMs} error=${job.error}`);
        await wait(backoffMs);
        queue.push(job.id);
      } else {
        job.status = 'failed';
        // eslint-disable-next-line no-console
        console.error(`[jobQueue] job=${job.id} type=${job.type} status=failed attempts=${job.attempts} error=${job.error}`);
      }
    }
  }

  running = false;
}

module.exports = {
  addJob,
  getJob,
  getQueueState,
};
