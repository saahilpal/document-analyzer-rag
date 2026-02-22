const pdfParser = require('./pdfParser');
const txtParser = require('./txtParser');
const mdParser = require('./mdParser');
const docxParser = require('./docxParser');
const csvParser = require('./csvParser');

const parsers = {
  pdf: pdfParser,
  txt: txtParser,
  md: mdParser,
  docx: docxParser,
  csv: csvParser,
};

async function parseFile({ filePath, fileType }) {
  const normalizedType = String(fileType || '').trim().toLowerCase();
  const parser = parsers[normalizedType];
  if (!parser || typeof parser.parse !== 'function') {
    const error = new Error(`Unsupported file type: ${normalizedType || 'unknown'}`);
    error.statusCode = 415;
    error.code = 'UNSUPPORTED_FILE_TYPE';
    throw error;
  }

  return parser.parse(filePath);
}

module.exports = {
  parsers,
  parseFile,
};
