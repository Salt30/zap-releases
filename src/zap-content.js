// Adapted from the regular answer and flashcard views in Zap 3.37.4.
// Build only text nodes and a small set of formatting elements. Model output
// must never become HTML, an executable link, or a renderer instruction.
function renderAnswer(target, text) {
  const doc = target.ownerDocument;
  target.replaceChildren();
  function inline(parent, value) {
    const pattern = /(`[^`\n]+`|\*\*[^*\n]+\*\*|\*[^*\n]+\*)/g;
    let offset = 0;
    for (const match of value.matchAll(pattern)) {
      parent.append(doc.createTextNode(value.slice(offset, match.index)));
      const token = match[0];
      const width = token.startsWith('**') ? 2 : 1;
      const element = doc.createElement(token.startsWith('`') ? 'code' : width === 2 ? 'strong' : 'em');
      element.textContent = token.slice(width, -width);
      parent.append(element);
      offset = match.index + token.length;
    }
    parent.append(doc.createTextNode(value.slice(offset)));
  }
  let code = null;
  let list = null;
  for (const line of String(text).slice(0, 100000).split('\n')) {
    if (/^\s*```/.test(line)) {
      list = null;
      if (code) { code = null; continue; }
      const pre = doc.createElement('pre');
      code = doc.createElement('code'); pre.append(code); target.append(pre);
      continue;
    }
    if (code) { code.append(doc.createTextNode(line + '\n')); continue; }
    const heading = line.match(/^(#{1,3})\s+(.+)$/);
    const item = line.match(/^\s*(?:[-*•]|\d+[.)])\s+(.+)$/);
    if (item) {
      const type = /^\s*\d/.test(line) ? 'OL' : 'UL';
      if (!list || list.tagName !== type) { list = doc.createElement(type.toLowerCase()); target.append(list); }
      const li = doc.createElement('li'); inline(li, item[1]); list.append(li);
    } else {
      list = null;
      const element = doc.createElement(heading ? `h${heading[1].length + 2}` : 'p');
      inline(element, heading ? heading[2] : line || '\u00a0'); target.append(element);
    }
  }
}

function validCards(cards) {
  if (!Array.isArray(cards) || !cards.length || cards.length > 30) return [];
  if (cards.some(card => !card || typeof card.front !== 'string' || typeof card.back !== 'string' || !card.front.trim() || !card.back.trim() || card.front.length > 4000 || card.back.length > 8000)) return [];
  return cards.map(({ front, back }) => ({ front: front.trim(), back: back.trim() }));
}

function parseStudyCards(text) {
  if (typeof text !== 'string' || text.length > 100000) return [];
  try {
    const parsed = JSON.parse(text.replace(/^\s*```(?:json)?\s*/i, '').replace(/\s*```\s*$/, ''));
    return validCards(parsed?.cards);
  } catch { /* Older Zap responses use numbered Q: / A: lines. */ }
  const cards = [];
  let front = ''; let back = ''; let side = '';
  const save = () => { if (front && back) cards.push({ front, back }); };
  for (const line of text.split('\n')) {
    const match = line.match(/^\s*(?:\d+[.)]\s*)?(?:\*\*)?([QA]):(?:\*\*)?\s*(.*)$/i);
    if (match?.[1].toUpperCase() === 'Q') {
      save(); front = ''; back = ''; side = 'front';
      // Support the inline arrow format accepted by the original study view.
      const parts = match[2].split(/\s*→\s*(?:\*\*)?A:(?:\*\*)?\s*/i);
      front = parts[0];
      if (parts.length > 1) { back = parts.slice(1).join(' → '); side = 'back'; }
    } else if (match && front) { back = match[2]; side = 'back'; }
    else if (side && line.trim()) {
      if (side === 'front') front += '\n' + line.trim();
      else back += '\n' + line.trim();
    }
    if (cards.length > 30) return [];
  }
  save();
  return validCards(cards);
}

module.exports = { renderAnswer, parseStudyCards, validCards };
