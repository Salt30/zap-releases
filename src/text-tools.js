'use strict';

const TEMPLATE_FIELD_PATTERN = /{{\s*([A-Za-z0-9_ -]{1,40})\s*}}/g;

function cleanSpacing(value) {
  return String(value || '')
    .replace(/\r\n?/g, '\n')
    .replace(/[\t ]+$/gm, '')
    .replace(/^[\t ]+/gm, '')
    .replace(/[\t ]{2,}/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function toggleBulletsText(value) {
  const lines = String(value || '').split('\n');
  const contentLines = lines.filter((line) => line.trim());
  const allBulleted = contentLines.length > 0 && contentLines.every((line) => /^\s*[•*-]\s+/.test(line));
  return {
    added: !allBulleted,
    text: lines.map((line) => {
      if (!line.trim()) return '';
      const content = line.replace(/^\s*[•*-]\s+/, '').trim();
      return allBulleted ? content : `• ${content}`;
    }).join('\n')
  };
}

function variableNames(body) {
  const names = [];
  const seen = new Set();
  TEMPLATE_FIELD_PATTERN.lastIndex = 0;
  for (const match of String(body || '').matchAll(TEMPLATE_FIELD_PATTERN)) {
    const key = match[1].trim();
    if (!seen.has(key)) {
      seen.add(key);
      names.push(key);
    }
  }
  return names;
}

function hasUnresolvedVariables(body) {
  TEMPLATE_FIELD_PATTERN.lastIndex = 0;
  return TEMPLATE_FIELD_PATTERN.test(String(body || ''));
}

function fillTemplate(body, values = {}) {
  TEMPLATE_FIELD_PATTERN.lastIndex = 0;
  return String(body || '').replace(TEMPLATE_FIELD_PATTERN, (_match, key) => String(values[key.trim()] ?? ''));
}

module.exports = {
  cleanSpacing,
  fillTemplate,
  hasUnresolvedVariables,
  toggleBulletsText,
  variableNames
};
