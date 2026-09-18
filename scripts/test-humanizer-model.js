const assert = require('node:assert/strict');
const { rewriteWithLocalModel } = require('../src/humanizer-model');

(async () => {
  let request;
  const fake = async (url, options) => {
    request = { url, options };
    return new Response(JSON.stringify({ text: "I'm ready.", engine: 'trained-local-model' }));
  };
  const result = await rewriteWithLocalModel('I am ready.', fake);
  assert.equal(result.text, "I'm ready.");
  assert.equal(request.url, 'http://127.0.0.1:8765/rewrite');
  assert.equal(request.options.redirect, 'error');
  assert.equal(request.options.headers['X-Drip-Humanizer'], '1');
  assert.deepEqual(JSON.parse(request.options.body), { text: 'I am ready.' });
  const mustNotCall = async () => { throw new Error('Should not send invalid input'); };
  assert.match((await rewriteWithLocalModel(' ', mustNotCall)).error, /1,500/);
  assert.match((await rewriteWithLocalModel('a'.repeat(1501), mustNotCall)).error, /1,500/);
  assert.match((await rewriteWithLocalModel('Ready.', async () => { throw new TypeError('offline'); })).error, /Start the local/);
  assert.match((await rewriteWithLocalModel('Ready.', async () => new Response('invalid'))).error, /Start the local/);
  assert.match((await rewriteWithLocalModel('Ready.', async () => new Response('{}'))).error, /invalid response/);
  assert.equal((await rewriteWithLocalModel('Ready.', async () => new Response('{"error":"Changed numbers"}', { status: 422 }))).error, 'Changed numbers');
  console.log('Local model client passed: loopback requests, input limits, errors, and response validation.');
})().catch((error) => { console.error(error); process.exitCode = 1; });
