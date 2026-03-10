const fs = require('fs/promises');
const pdfParse = require('pdf-parse');
const { ensureTextNotEmpty } = require('./utils');
const env = require('../config/env');

async function parse(filePath) {
  const buffer = await fs.readFile(filePath);
  if (!buffer || !Buffer.isBuffer(buffer)) {
    const error = new Error('Invalid PDF file buffer.');
    error.statusCode = 400;
    error.code = 'INVALID_PDF_BUFFER';
    throw error;
  }

  const parsed = await pdfParse(buffer);
  const numPages = Number(parsed?.numpages || 0);
  if (numPages > env.maxPdfPages) {
    const error = new Error(`PDF exceeds page limit (${env.maxPdfPages}).`);
    error.statusCode = 400;
    error.code = 'PDF_PAGE_LIMIT_EXCEEDED';
    throw error;
  }
  return ensureTextNotEmpty(parsed?.text || '', 'PDF_TEXT_EMPTY');
}

module.exports = {
  parse,
};
