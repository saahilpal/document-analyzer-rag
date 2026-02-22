const fs = require('fs/promises');
const { decodeUtf8Buffer, ensureTextNotEmpty } = require('./utils');

async function parse(filePath) {
  const buffer = await fs.readFile(filePath);
  const text = decodeUtf8Buffer(buffer);
  return ensureTextNotEmpty(text, 'TXT_TEXT_EMPTY');
}

module.exports = {
  parse,
};
