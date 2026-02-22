const fs = require('fs/promises');
const { decodeUtf8Buffer, ensureTextNotEmpty } = require('./utils');

function parseCsvRows(text) {
  const rows = [];
  let row = [];
  let field = '';
  let inQuotes = false;

  for (let i = 0; i < text.length; i += 1) {
    const char = text[i];

    if (char === '"') {
      const next = text[i + 1];
      if (inQuotes && next === '"') {
        field += '"';
        i += 1;
      } else {
        inQuotes = !inQuotes;
      }
      continue;
    }

    if (char === ',' && !inQuotes) {
      row.push(field);
      field = '';
      continue;
    }

    if ((char === '\n' || char === '\r') && !inQuotes) {
      if (char === '\r' && text[i + 1] === '\n') {
        i += 1;
      }
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
      continue;
    }

    field += char;
  }

  if (field.length > 0 || row.length > 0) {
    row.push(field);
    rows.push(row);
  }

  return rows
    .map((candidate) => candidate.map((value) => String(value || '').trim()))
    .filter((candidate) => candidate.some((value) => value.length > 0));
}

function toReadableRows(rows) {
  if (rows.length === 0) {
    return '';
  }

  if (rows.length === 1) {
    return rows[0].join(' ').trim();
  }

  const header = rows[0].map((value, index) => value || `column${index + 1}`);
  const contentRows = rows.slice(1);

  const sentences = contentRows
    .map((row) => {
      const pieces = [];
      for (let i = 0; i < header.length; i += 1) {
        const key = String(header[i] || '').trim();
        const value = String(row[i] || '').trim();
        if (!key && !value) {
          continue;
        }
        if (value) {
          pieces.push(`${key} ${value}`.trim());
        }
      }
      return pieces.join(' ').trim();
    })
    .filter((line) => line.length > 0);

  return sentences.join('\n');
}

async function parse(filePath) {
  const buffer = await fs.readFile(filePath);
  const csvText = decodeUtf8Buffer(buffer);
  const rows = parseCsvRows(csvText);
  const readable = toReadableRows(rows);
  return ensureTextNotEmpty(readable, 'CSV_TEXT_EMPTY');
}

module.exports = {
  parse,
  parseCsvRows,
  toReadableRows,
};
