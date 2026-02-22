const mammoth = require('mammoth');
const { ensureTextNotEmpty } = require('./utils');

async function parse(filePath) {
  const result = await mammoth.extractRawText({ path: filePath });
  return ensureTextNotEmpty(result?.value || '', 'DOCX_TEXT_EMPTY');
}

module.exports = {
  parse,
};
