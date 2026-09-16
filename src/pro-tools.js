'use strict';

const { cleanSpacing, fillTemplate, variableNames } = require('./text-tools');

const MAX_BATCH_ROWS = 250;
const MAX_BATCH_CELL_LENGTH = 2000;

function parseDelimitedRow(line, delimiter) {
  const cells = [];
  let value = '';
  let quoted = false;
  for (let index = 0; index < line.length; index += 1) {
    const character = line[index];
    if (character === '"') {
      if (quoted && line[index + 1] === '"') {
        value += '"';
        index += 1;
      } else {
        quoted = !quoted;
      }
    } else if (character === delimiter && !quoted) {
      cells.push(value.slice(0, MAX_BATCH_CELL_LENGTH));
      value = '';
    } else {
      value += character;
    }
  }
  cells.push(value.slice(0, MAX_BATCH_CELL_LENGTH));
  return cells.map((cell) => cell.trim());
}

function parseBatchRows(input) {
  const lines = String(input || '').replace(/\r\n?/g, '\n').split('\n').filter((line) => line.trim());
  if (lines.length < 2) return { headers: [], rows: [], errors: ['Add a header row and at least one data row.'] };
  const delimiter = lines[0].includes('\t') ? '\t' : ',';
  const headers = parseDelimitedRow(lines[0], delimiter).map((header) => header.replace(/[^A-Za-z0-9_ -]/g, '').trim());
  if (!headers.length || headers.some((header) => !header) || new Set(headers).size !== headers.length) {
    return { headers: [], rows: [], errors: ['Headers must be unique, non-empty field names.'] };
  }
  const errors = [];
  const rows = lines.slice(1, MAX_BATCH_ROWS + 1).map((line, index) => {
    const cells = parseDelimitedRow(line, delimiter);
    if (cells.length !== headers.length) errors.push(`Row ${index + 2} has ${cells.length} values; expected ${headers.length}.`);
    return Object.fromEntries(headers.map((header, cellIndex) => [header, cells[cellIndex] || '']));
  });
  if (lines.length - 1 > MAX_BATCH_ROWS) errors.push(`Only the first ${MAX_BATCH_ROWS} data rows were used.`);
  return { headers, rows, errors };
}

function renderBatch(templateBody, input) {
  const parsed = parseBatchRows(input);
  const fields = variableNames(templateBody);
  const missingHeaders = fields.filter((field) => !parsed.headers.includes(field));
  const errors = [...parsed.errors];
  if (missingHeaders.length) errors.push(`Missing columns: ${missingHeaders.join(', ')}.`);
  if (errors.some((error) => error.startsWith('Missing columns:'))) return { ...parsed, fields, outputs: [], errors };
  return {
    ...parsed,
    fields,
    outputs: parsed.rows.map((row, index) => ({ index: index + 1, text: fillTemplate(templateBody, row) })),
    errors
  };
}

function splitSentences(value) {
  return cleanSpacing(value).split(/(?<=[.!?])\s+/).filter(Boolean);
}

function humanizeWriting(value) {
  const replacements = [
    ['in order to', 'to'],
    ['due to the fact that', 'because'],
    ['at this point in time', 'now'],
    ['in the event that', 'if'],
    ['with regard to', 'about'],
    ['prior to', 'before'],
    ['I am', "I'm"], ['I will', "I'll"],
    ['you are', "you're"], ['we are', "we're"], ['they are', "they're"],
    ['do not', "don't"], ['does not', "doesn't"], ['did not', "didn't"],
    ['cannot', "can't"], ['will not', "won't"],
    ['is not', "isn't"], ['are not', "aren't"]
  ];
  // Keep templates, code, links, and quoted language exactly as supplied.
  const protectedText = /(```[\s\S]*?(?:```|$)|`[^`\n]*`|{{[\s\S]*?}}|https?:\/\/[^\s]+|\[[^\]\n]*\]\([^\n)]*\)|"[^"\n]*"|“[^”\n]*”)/g;
  return String(value || '').split(protectedText).map((part, index) => {
    if (index % 2) return part;
    for (const [phrase, replacement] of replacements) {
      // Subject contractions need a following complement: keep "Yes, I am."
      const continuation = /^(I|you|we|they) /.test(phrase) ? '(?=[ \\t]+[A-Za-z])' : '';
      part = part.replace(new RegExp(`\\b${phrase}\\b${continuation}`, 'gi'), (match) => {
        if (match === match.toUpperCase()) return replacement.toUpperCase();
        if (/^[A-Z]/.test(match)) return replacement[0].toUpperCase() + replacement.slice(1);
        return replacement;
      });
    }
    return part;
  }).join('');
}

function transformWriting(value, mode) {
  if (mode === 'humanize') return humanizeWriting(value);
  const text = cleanSpacing(String(value || '').slice(0, 100000));
  if (!text) return '';
  if (mode === 'tighten') {
    return text
      .replace(/\b(in order to)\b/gi, 'to')
      .replace(/\b(due to the fact that)\b/gi, 'because')
      .replace(/\b(at this point in time)\b/gi, 'now')
      .replace(/\b(very|really|quite|basically|actually)\b\s*/gi, '')
      .replace(/\s+([,.;!?])/g, '$1');
  }
  if (mode === 'warm') {
    const sentences = splitSentences(text);
    const opening = /^(hi|hello|hey)\b/i.test(text) ? '' : 'Hi — ';
    const closing = /\b(thanks|thank you|best|cheers)[!.]?$/i.test(text) ? '' : '\n\nThanks!';
    return `${opening}${sentences.join(' ')}${closing}`;
  }
  if (mode === 'direct') {
    return text
      .replace(/\b(I (?:just )?wanted to|I was hoping to|Would it be possible to)\s+/gi, '')
      .replace(/\b(maybe|perhaps|possibly)\b\s*/gi, '')
      .replace(/\s+([,.;!?])/g, '$1');
  }
  if (mode === 'outline') {
    return splitSentences(text).map((sentence) => `• ${sentence}`).join('\n');
  }
  return text;
}

function searchClipboard(items, query) {
  const needle = String(query || '').trim().toLocaleLowerCase();
  const safeItems = Array.isArray(items) ? items : [];
  if (!needle) return safeItems;
  return safeItems.filter((item) => String(item?.text || '').toLocaleLowerCase().includes(needle));
}

module.exports = {
  MAX_BATCH_ROWS,
  parseBatchRows,
  renderBatch,
  searchClipboard,
  transformWriting
};
