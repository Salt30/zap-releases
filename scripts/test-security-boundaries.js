const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const billing = require('../website/api/_billing');
const limits = require('../website/server/rate-limit');
const support = require('../website/api/support-ticket');
(async () => {
  const source = fs.readFileSync(path.join(__dirname, '../src/main.js'), 'utf8');
  const context = { URL, path, APP_SCHEME: 'drip', APP_HOST: 'app' };
  vm.createContext(context);
  vm.runInContext(source.slice(source.indexOf('function senderPage('), source.indexOf('function handleTrusted(')), context);
  const frame = { url: 'drip://app/index.html' }; const sender = { mainFrame: frame };
  assert.doesNotThrow(() => context.assertTrustedSender({ sender, senderFrame: frame }, ['index.html']));
  for (const url of ['https://tryzap.net/index.html','drip://app/nested/index.html','drip://app:80/index.html','drip://user@app/index.html']) {
    frame.url = url; assert.throws(() => context.assertTrustedSender({ sender, senderFrame: frame }, ['index.html']), /untrusted/);
  }
  frame.url = 'drip://app/index.html';
  assert.throws(() => context.assertTrustedSender({ sender, senderFrame: { url: frame.url } }, ['index.html']), /untrusted/);
  assert.throws(() => context.assertTrustedSender({ sender }, ['index.html']), /untrusted/);
  for (const token of ['nvapi-' + 'x'.repeat(48), 'sk-proj-' + 'x'.repeat(48), 'gsk_' + 'x'.repeat(48)]) {
    assert.equal(support.containsSensitiveData(token), true);
  }
  const original = limits.consume;
  let response;
  const reset = () => { response = { headers: {}, setHeader(k,v) { this.headers[k]=v; }, status(code) { this.code=code; return this; }, json(body) { this.body=body; return this; } }; };
  try {
    limits.consume = async () => { throw new Error('secret upstream detail'); };
    reset(); assert.equal(await billing.limitRequest({}, response), false); assert.equal(response.code,503); assert.doesNotMatch(JSON.stringify(response.body), /secret upstream/);
    limits.consume = async () => ({ allowed: false, retryAfter: 12 });
    reset(); assert.equal(await billing.limitRequest({}, response),false); assert.equal(response.code,429); assert.equal(response.headers['Retry-After'],'12');
  } finally { limits.consume = original; }
  assert.doesNotMatch(source, /(?:listTemplates|saveTemplate|saveProfile|captureClipboardItem|rewriteWithLocalModel)\(/);
  assert.doesNotMatch(source, /store\.(?:delete|set)\(['"](?:encryptedUserVault|templates|profiles|clipboardWorkspace)['"]/);
  console.log('Security boundaries passed: main-frame IPC, retired APIs, saved data preservation, sensitive support content, fail-closed rate limiting.');
})().catch(error => { console.error(error); process.exitCode = 1; });
