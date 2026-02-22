function sanitizeExtractedText(input) {
  const normalized = String(input || '')
    .replace(/\u0000/g, '')
    .normalize('NFKC')
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, '\n')
    .replace(/\uFEFF/g, '');

  return normalized
    .replace(/[\t\f\v]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .replace(/[ ]{2,}/g, ' ')
    .replace(/\n[ ]+/g, '\n')
    .trim();
}

function ensureTextNotEmpty(text, code = 'EMPTY_PARSED_TEXT') {
  const normalized = sanitizeExtractedText(text);
  if (!normalized) {
    const error = new Error('Failed to extract readable text from uploaded file.');
    error.statusCode = 400;
    error.code = code;
    throw error;
  }
  return normalized;
}

function decodeUtf8Buffer(buffer) {
  const decoder = new TextDecoder('utf-8', { fatal: true });
  return decoder.decode(buffer);
}

module.exports = {
  sanitizeExtractedText,
  ensureTextNotEmpty,
  decodeUtf8Buffer,
};
