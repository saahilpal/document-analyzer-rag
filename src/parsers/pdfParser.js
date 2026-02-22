const fs = require('fs/promises');
const pdfParse = require('pdf-parse');
const { ensureTextNotEmpty } = require('./utils');

async function parse(filePath) {
  const buffer = await fs.readFile(filePath);
  if (!buffer || !Buffer.isBuffer(buffer)) {
    const error = new Error('Invalid PDF file buffer.');
    error.statusCode = 400;
    error.code = 'INVALID_PDF_BUFFER';
    throw error;
  }

  const parsed = await pdfParse(buffer);
  return ensureTextNotEmpty(parsed?.text || '', 'PDF_TEXT_EMPTY');
}

module.exports = {
  parse,
};
