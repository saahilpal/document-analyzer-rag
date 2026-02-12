const app = require('./app');

const port = Number(process.env.PORT) || 4000;
const host = process.env.HOST || '0.0.0.0';

app.listen(port, host, () => {
  // eslint-disable-next-line no-console
  console.log(`StudyRAG backend running on ${host}:${port}`);
});
