const app = require('./app');
const { startCleanupWorker } = require('./services/cleanupService');
const { logError, logInfo } = require('./config/logger');
const env = require('./config/env');

const port = env.port;
const host = env.host;

process.on('unhandledRejection', (reason) => {
  logError('ERROR_QUEUE', reason instanceof Error ? reason : new Error(String(reason)), {
    stage: 'unhandledRejection',
  });
});

process.on('uncaughtException', (error) => {
  logError('ERROR_QUEUE', error, {
    stage: 'uncaughtException',
  });
});

app.listen(port, host, () => {
  startCleanupWorker();
  logInfo('SERVER_READY', { url: `http://${host}:${port}` });
});
