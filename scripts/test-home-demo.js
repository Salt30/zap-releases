const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

class FakeClassList {
  constructor() {
    this.values = new Set();
  }

  add(...values) {
    values.forEach((value) => this.values.add(value));
  }

  remove(...values) {
    values.forEach((value) => this.values.delete(value));
  }
}

const makeStyle = () => ({
  values: new Map(),
  setProperty(key, value) {
    this.values.set(key, value);
  },
});

const makeControl = (name, value, min, max) => {
  const listeners = new Map();
  return {
    dataset: { rhythmControl: name },
    value: String(value),
    min: String(min),
    max: String(max),
    style: makeStyle(),
    addEventListener(type, listener) {
      listeners.set(type, listener);
    },
    dispatch(type) {
      listeners.get(type)?.({ target: this });
    },
  };
};

const controls = {
  wpm: makeControl('wpm', 120, 15, 120),
  delay: makeControl('delay', 1, 1, 15),
  typos: makeControl('typos', 15, 0, 15),
  pauses: makeControl('pauses', 12, 0, 12),
  bursts: makeControl('bursts', 25, 0, 25),
};
const outputs = Object.fromEntries(Object.keys(controls).map((name) => [
  name,
  { dataset: { rhythmOutput: name }, textContent: '' },
]));
const statusHistory = [];
const demoStatus = {};
Object.defineProperty(demoStatus, 'textContent', {
  get() {
    return statusHistory.at(-1) || '';
  },
  set(value) {
    statusHistory.push(String(value));
  },
});

const demo = {
  classList: new FakeClassList(),
  style: makeStyle(),
  scrollIntoView() {},
  offsetWidth: 1,
};
const demoText = { textContent: '' };
const demoProgress = { style: { width: '' } };
const inertButton = { addEventListener() {} };
const documentListeners = new Map();
const document = {
  hidden: true,
  getElementById(id) {
    return id === 'demo' ? demo : id === 'try-interaction' ? inertButton : null;
  },
  querySelector(selector) {
    return {
      '[data-demo-replay]': inertButton,
      '[data-demo-text]': demoText,
      '[data-demo-status]': demoStatus,
      '[data-demo-progress]': demoProgress,
    }[selector] || null;
  },
  querySelectorAll(selector) {
    if (selector === '[data-rhythm-control]') return Object.values(controls);
    if (selector === '[data-rhythm-output]') return Object.values(outputs);
    return [];
  },
  addEventListener(type, listener) {
    documentListeners.set(type, listener);
  },
};

const fakeWindow = {
  document,
  matchMedia: () => ({ matches: false }),
  setTimeout: (callback) => setImmediate(callback),
  clearTimeout: (handle) => clearImmediate(handle),
};
class FakeIntersectionObserver {
  constructor(callback) {
    this.callback = callback;
  }

  observe() {
    setImmediate(() => this.callback([{ isIntersecting: true }]));
  }

  disconnect() {}
}
fakeWindow.IntersectionObserver = FakeIntersectionObserver;

const source = fs.readFileSync(path.join(__dirname, '..', 'website', 'home-demo.js'), 'utf8');
vm.runInNewContext(source, {
  console,
  document,
  window: fakeWindow,
  IntersectionObserver: FakeIntersectionObserver,
  Promise,
  Object,
  Math,
  Set,
});

const waitFor = async (predicate, message) => {
  const deadline = Date.now() + 1500;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error(message);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
};

(async () => {
  await waitFor(
    () => statusHistory.some((status) => status.includes('4 corrections · 4 pauses · replay')),
    'Maximum correction and pause settings did not complete four representative effects.',
  );
  assert.equal(demoText.textContent, 'Drip Type types finished words naturally into any app.');
  assert(statusHistory.includes('Correcting typo 4 of 4 · 15%'));
  assert(statusHistory.includes('Thinking pause 4 of 4 · 12%'));

  statusHistory.length = 0;
  controls.typos.value = '0';
  controls.pauses.value = '0';
  controls.typos.dispatch('input');
  controls.pauses.dispatch('input');
  await waitFor(
    () => statusHistory.some((status) => status.includes('0 corrections · 0 pauses · replay')),
    'Zero correction and pause settings did not complete without representative effects.',
  );
  assert.equal(demoText.textContent, 'Drip Type types finished words naturally into any app.');
  assert(!statusHistory.some((status) => status.startsWith('Correcting typo')));
  assert(!statusHistory.some((status) => status.startsWith('Thinking pause')));
  console.log('Interactive website typing controls passed maximum and zero effect tests.');
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
