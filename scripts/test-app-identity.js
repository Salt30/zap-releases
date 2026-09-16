const assert = require('node:assert/strict');
const path = require('node:path');
const { configureAppIdentity } = require('../src/app-identity');

function resolve(existing, platform = 'win32') {
  const calls = [];
  let ready;
  const base = path.resolve('fixture-app-data');
  const app = {
    getPath: (name) => { assert.equal(name, 'appData'); return base; },
    setName: (name) => calls.push(['name', name]),
    setPath: (name, value) => calls.push([name, value]),
    once: (event, callback) => { assert.equal(event, 'ready'); ready = callback; }
  };
  const result = configureAppIdentity(app, (file) => existing.includes(path.relative(base, file)), platform);
  const legacyMac = platform === 'darwin' && path.basename(result) !== 'Zap';
  assert.deepEqual(calls, [['name', legacyMac ? 'Drip Type' : 'Zap'], ['userData', result]]);
  if (legacyMac) { ready(); assert.deepEqual(calls.at(-1), ['name', 'Zap']); }
  else assert.equal(ready, undefined);
  return path.relative(base, result);
}

assert.equal(resolve([]), 'Zap');
assert.equal(resolve([path.join('Drip Type', 'config.json')]), 'Drip Type');
assert.equal(resolve([path.join('drip-type', 'config.json')]), 'drip-type');
assert.equal(resolve([path.join('Zap', 'config.json'), path.join('Drip Type', 'config.json')]), 'Zap');
assert.equal(resolve([path.join('Zap Pro', 'zap-config.json')]), 'Zap');
assert.equal(resolve([path.join('Drip Type', 'config.json')], 'darwin'), 'Drip Type');
assert.equal(resolve([path.join('drip-type', 'config.json')], 'darwin'), 'drip-type');
assert.equal(resolve([], 'darwin'), 'Zap');
console.log('App identity: fresh installs and legacy settings preservation passed.');
