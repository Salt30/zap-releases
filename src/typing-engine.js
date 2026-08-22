const NEARBY = {
  a: 'sqwz', b: 'vngh', c: 'xvdf', d: 'sfcxer', e: 'wrsd', f: 'dgcvrt',
  g: 'fhvbty', h: 'gjbnyu', i: 'ujko', j: 'hknmui', k: 'jlmio', l: 'kop',
  m: 'njk', n: 'bmhj', o: 'iklp', p: 'ol', q: 'wa', r: 'edft', s: 'awdxze',
  t: 'rfgy', u: 'yhji', v: 'cbfg', w: 'qase', x: 'zsdc', y: 'tghu', z: 'xsa',
  '1': '2q', '2': '13qw', '3': '24we', '4': '35er', '5': '46rt',
  '6': '57ty', '7': '68yu', '8': '79ui', '9': '80io', '0': '9p'
};

function typoChar(character, random = Math.random) {
  const pool = NEARBY[character.toLowerCase()];
  if (!pool) return character;
  const typo = pool[Math.floor(random() * pool.length)];
  return character === character.toUpperCase() ? typo.toUpperCase() : typo;
}

function humanMs(base, random = Math.random) {
  const gaussian = () => {
    let u = 0;
    let v = 0;
    while (!u) u = random();
    while (!v) v = random();
    return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
  };

  let delay = base + gaussian() * base * 0.6;
  if (random() < 0.02) delay += 200 + random() * 400;
  return Math.max(15, Math.round(delay));
}

function delayEvent(milliseconds) {
  return { type: 'delay', ms: Math.max(0, Math.min(5000, Math.round(milliseconds))) };
}

function buildCharacterSteps(text, speed, typoRate, pauseChance, burstChance, random = Math.random) {
  return [...text].map((character, index) => {
    const events = [];

    if (random() < pauseChance && index > 0) {
      events.push(delayEvent(1000 + random() * 2500));
    }

    const characterSpeed = random() < burstChance ? speed * 0.5 : speed;
    const delay = humanMs(characterSpeed, random);

    if (/[a-zA-Z]/.test(character) && random() < typoRate) {
      const wrong = typoChar(character, random);
      events.push({ type: 'text', value: wrong });
      events.push(delayEvent(300 + random() * 500));
      events.push({ type: 'key', value: 'backspace' });
      events.push(delayEvent(80 + random() * 120));
      if (wrong !== character) events.push(delayEvent(50 + random() * 100));
      events.push({ type: 'text', value: character });
      events.push(delayEvent(delay));
    } else if (character === '\n') {
      events.push({ type: 'key', value: 'enter' });
      events.push(delayEvent(delay + 300 + random() * 500));
    } else if (character === '\t') {
      events.push({ type: 'key', value: 'tab' });
      events.push(delayEvent(delay));
    } else {
      events.push({ type: 'text', value: character });
      const punctuationDelay = '.!?'.includes(character)
        ? 400 + random() * 800
        : character === ',' ? 100 + random() * 300 : 0;
      events.push(delayEvent(delay + punctuationDelay));
    }

    return events;
  });
}

function escapeAppleScript(value) {
  return value
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"')
    .replace(/\r/g, '\\r')
    .replace(/\n/g, '\\n')
    .replace(/\t/g, '\\t');
}

function renderAppleScript(events) {
  const commands = events.map((event) => {
    if (event.type === 'delay') return `delay ${(event.ms / 1000).toFixed(4)}`;
    if (event.type === 'text') return `keystroke "${escapeAppleScript(event.value)}"`;
    if (event.type === 'key' && event.value === 'backspace') return 'key code 51';
    if (event.type === 'key' && event.value === 'enter') return 'key code 36';
    if (event.type === 'key' && event.value === 'tab') return 'key code 48';
    throw new Error('Unsupported typing event.');
  });
  return `tell application "System Events"\n${commands.join('\n')}\nend tell`;
}

function validateTypingEvents(events) {
  if (!Array.isArray(events) || events.length > 1000) return false;
  return events.every((event) => {
    if (!event || typeof event !== 'object' || Array.isArray(event)) return false;
    if (event.type === 'text') return typeof event.value === 'string' && [...event.value].length === 1;
    if (event.type === 'delay') return Number.isInteger(event.ms) && event.ms >= 0 && event.ms <= 5000;
    if (event.type === 'key') return ['backspace', 'enter', 'tab'].includes(event.value);
    return false;
  });
}

module.exports = { buildCharacterSteps, renderAppleScript, validateTypingEvents };
