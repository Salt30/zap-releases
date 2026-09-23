// Expanded study controls adapted from Zap 3.37.4's flashcards view.
// The deck exists only in memory and is discarded on sign-out/history clear.
const { validCards } = require('./zap-content');

function initStudy(doc = document) {
  const $ = id => doc.getElementById(id);
  const dialog = $('zap-study-dialog');
  let cards = []; let index = 0; let flipped = false;
  function render() {
    if (!cards.length) return;
    $('zap-study-progress').textContent = `Card ${index + 1} of ${cards.length}`;
    $('zap-study-side').textContent = flipped ? 'Answer' : 'Question';
    $('zap-study-text').textContent = cards[index][flipped ? 'back' : 'front'];
    $('zap-study-flip').setAttribute('aria-label', flipped ? 'Show question' : 'Show answer');
    $('zap-study-prev').disabled = index === 0;
    $('zap-study-next').disabled = index === cards.length - 1;
    [...$('zap-study-dots').children].forEach((button, i) => button.setAttribute('aria-current', String(i === index)));
  }
  function navigate(next) { index = Math.max(0, Math.min(cards.length - 1, next)); flipped = false; render(); }
  function flip() { flipped = !flipped; render(); }
  $('zap-study-flip').addEventListener('click', flip);
  $('zap-study-prev').addEventListener('click', () => navigate(index - 1));
  $('zap-study-next').addEventListener('click', () => navigate(index + 1));
  $('zap-study-close').addEventListener('click', () => dialog.close());
  $('zap-study-shuffle').addEventListener('click', () => {
    for (let i = cards.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [cards[i], cards[j]] = [cards[j], cards[i]];
    }
    navigate(0);
  });
  dialog.addEventListener('keydown', event => {
    if (event.altKey || event.metaKey || event.ctrlKey || event.isComposing) return;
    if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
      event.preventDefault(); navigate(index + (event.key === 'ArrowLeft' ? -1 : 1));
    } else if (event.key === ' ' && (event.target === dialog || event.target === $('zap-study-flip'))) {
      event.preventDefault(); flip();
    }
    // Enter/Space on other buttons keep their normal actions; Escape closes
    // the native dialog and restores focus to its opener.
  });
  return {
    open(value) {
      cards = validCards(value);
      if (!cards.length) return;
      $('zap-study-dots').replaceChildren();
      cards.forEach((_card, i) => {
        const button = doc.createElement('button'); button.type = 'button';
        button.textContent = String(i + 1); button.setAttribute('aria-label', `Go to card ${i + 1}`);
        button.addEventListener('click', () => navigate(i)); $('zap-study-dots').append(button);
      });
      navigate(0); dialog.showModal(); $('zap-study-flip').focus();
    },
    clear() {
      if (dialog.open) dialog.close();
      cards = []; index = 0; flipped = false;
      for (const id of ['zap-study-progress', 'zap-study-side', 'zap-study-text', 'zap-study-dots']) $(id).replaceChildren();
    }
  };
}
module.exports = { initStudy };
