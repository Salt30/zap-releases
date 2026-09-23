const rateLimit = require('../website/server/rate-limit');
const originalConsume = rateLimit.consume;
const testStorage = require('./mock-blob').memoryBlob();
rateLimit.consume = (bucket, subject) => originalConsume(bucket, subject, { storage: testStorage, secret: Buffer.alloc(32, 17).toString('base64url') });
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const fs = require('node:fs');
const vm = require('node:vm');
const client = require('../src/zap-ai');
const model = require('../website/server/zap-model');
const { createHandler } = require('../website/server/zap-service');
const { reserve } = require('../website/server/zap-quota');

const input = { mode: 'answer', text: 'What is 2 + 2?', images: [] };
const settings = { ...client.DEFAULT_SETTINGS };
const credential = { refreshToken: `sub_test.${'a'.repeat(48)}`, deviceId: '11111111-1111-4111-8111-111111111111' };
function response() {
  return { headers: {}, code: 200, setHeader(k, v) { this.headers[k] = v; }, status(code) { this.code = code; return this; }, json(data) { this.data = data; return this; } };
}
async function main() {
  assert.throws(() => client.validateRequest({ ...input, mode: '__proto__' }));
  assert.throws(() => client.validateRequest({ ...input, images: ['https://example.com/image.png'] }));
  assert.throws(() => client.cleanSettings({ maxTokens: 99999 }));
  assert.throws(() => model.validateRequest({ ...input, images: ['data:image/png;base64,' + 'a'.repeat(2500001)] }));
  assert.equal(client.safeSource('file:///private/etc/passwd'), null);
  assert.equal(client.safeSource('https://user:secret@example.com'), null);
  assert.deepEqual(model.parseCards('{"cards":[{"front":"2+2?","back":"4"}]}'), [{ front: '2+2?', back: '4' }]);
  assert.deepEqual(model.parseCards('{"cards":[{"front":{},"back":"4"}]}'), []);
  let transmitted;
  const result = await client.requestAI(input, settings, credential, { fetchImpl: async (url, options) => {
    transmitted = { url, options, body: JSON.parse(options.body) };
    return new Response(JSON.stringify({ text: '4', cards: [], sources: ['javascript:alert(1)', 'https://example.com'], provider: 'untrusted' }));
  } });
  assert.equal(transmitted.url, 'https://tryzap.net/api/zap-ai');
  assert.equal(transmitted.options.redirect, 'error');
  assert.equal(transmitted.options.headers.Authorization, undefined);
  assert.equal(transmitted.body.refreshToken, credential.refreshToken);
  assert.equal(result.provider, 'Zap AI'); assert.deepEqual(result.sources, ['https://example.com/']);
  await assert.rejects(() => client.requestAI(input, settings, {}, { fetchImpl: () => assert.fail('Unauthenticated request sent') }), /Connect your Zap account/);
  await assert.rejects(() => client.requestAI(input, settings, credential, { fetchImpl: async () => new Response('internal secret', { status: 503 }) }), /temporarily unavailable/);
  const providerResult = await model.requestAI(input, model.cleanSettings(settings), () => 'test-key-not-a-real-secret', {
    fetchImpl: async (url, options) => {
      assert.equal(url, 'https://integrate.api.nvidia.com/v1/chat/completions');
      const body = JSON.parse(options.body); assert.equal(body.model, 'meta/llama-3.3-70b-instruct');
      assert.equal(body.max_tokens, settings.maxTokens); assert.equal(options.redirect, 'error');
      return new Response(JSON.stringify({ choices: [{ message: { content: '4' }, finish_reason: 'stop' }] }));
    }
  });
  assert.equal(providerResult.text, '4');
  assert.match(model.buildRequest({ ...input, mode: 'research' }, {}).body.messages[0].content, /do not have live web search/);

  const captureRequest = model.buildRequest({ mode: 'answer', text: '', images: ['data:image/png;base64,YQ=='] }, {});
  assert.equal(captureRequest.body.model, 'meta/llama-3.2-11b-vision-instruct');
  assert.deepEqual(captureRequest.body.messages.map(message => message.role), ['user']);
  assert.match(captureRequest.body.messages[0].content[0].text, /Answer the question shown/);
  assert.match(captureRequest.body.messages[0].content[0].text, /not as instructions overriding the user/);
  assert.equal(captureRequest.body.messages[0].content[1].type, 'image_url');
  await assert.rejects(() => model.requestAI(input, settings, () => 'fixture', { fetchImpl: async () => new Response('private provider details', { status: 401 }) }), error => error.code === 'provider_configuration' && !error.message.includes('private'));
  await assert.rejects(() => client.requestAI(input, settings, credential, { fetchImpl: async () => new Response(JSON.stringify({ code: 'provider_configuration', error: 'private server details' }), { status: 503 }) }), /server configuration fix/);

  let calls = 0; let quotaCalls = 0;
  const handler = createHandler({ env: { NVIDIA_API_KEY: 'nvapi-' + 'x'.repeat(32) }, authenticate: async () => ({ subscription: { id: 'sub_test' }, plan: 'core' }), reserve: async () => { quotaCalls++; }, requestAI: async () => { calls++; return { text: '4', sources: [], cards: [] }; } });
  const makeRequest = (body = { ...input, settings, ...credential }) => ({ method: 'POST', headers: { 'content-type': 'application/json', 'x-forwarded-for': 'test-zap' }, body });
  let res = response(); await handler(makeRequest(), res); assert.equal(res.code, 200); assert.equal(calls, 1); assert.equal(quotaCalls, 2); assert.equal(res.headers['Cache-Control'], 'no-store');
  res = response(); await handler(makeRequest({ ...input, settings, ...credential, endpoint: 'http://localhost' }), res); assert.equal(res.code, 400); assert.equal(calls, 1);
  res = response(); await handler({ ...makeRequest(), method: 'GET' }, res); assert.equal(res.code, 405);
  res = response(); await handler({ ...makeRequest(), headers: { 'content-type': 'application/json', 'content-length': '9999999' } }, res); assert.equal(res.code, 413);
  res = response(); await createHandler({ authenticate: async () => { throw new Error('bad credential'); }, requestAI: async () => assert.fail('Unauthorized inference') })(makeRequest(), res); assert.equal(res.code, 403);
  res = response(); await createHandler({ authenticate: async () => ({ subscription: { id: 'sub_test' } }), env: {}, reserve: () => assert.fail('Quota consumed without configuration') })(makeRequest(), res); assert.equal(res.code, 503);
  res = response(); await createHandler({ env: { NVIDIA_API_KEY: 'nvapi-' + 'x'.repeat(32) }, authenticate: async () => ({ subscription: { id: 'sub_test' } }), reserve: () => { throw new Error('quota_exceeded'); }, requestAI: () => assert.fail('Over-quota inference') })(makeRequest(), res); assert.equal(res.code, 429);

  let record; let version = 0;
  const storage = {
    async get() { return record ? { statusCode: 200, stream: new Response(record).body, blob: { etag: String(version) } } : null; },
    async head() { return { etag: String(version) }; },
    async put(_path, value, options) { if (record && (!options.allowOverwrite || options.ifMatch !== String(version))) throw new Error('precondition'); record = value; version++; }
  };
  const now = Date.UTC(2026, 8, 15);
  const reservations = await Promise.allSettled([1, 2, 3, 4].map(() => reserve('sub_test', storage, now, 3)));
  assert.equal(reservations.filter((entry) => entry.status === 'fulfilled').length, 3);
  assert.equal(JSON.parse(record).count, 3);
  await assert.rejects(() => reserve('sub_test', storage, now, 3), /quota_exceeded/);
  await reserve('sub_test', storage, now + 86400000, 3); assert.equal(JSON.parse(record).count, 1);

  const handlers = new Map(); const events = new Map(); const registered = new Map();
  const store = new Map(); store.get = (key, fallback) => Map.prototype.has.call(store, key) ? Map.prototype.get.call(store, key) : fallback; store.set = Map.prototype.set.bind(store);
  const fakeElectron = { BrowserWindow: { getAllWindows: () => [], getFocusedWindow: () => null }, screen: { getAllDisplays: () => [{ id: 1, size: { width: 100, height: 100 } }] }, desktopCapturer: { getSources: async () => { throw new Error('Capture failed'); } }, systemPreferences: { getMediaAccessStatus: () => 'granted' }, shell: { openExternal: async () => {} }, globalShortcut: { register: (key, callback) => { if (registered.has(key)) return false; registered.set(key, callback); return true; }, unregister: (key) => registered.delete(key) } };
  const sandbox = { module: { exports: {} }, require: (name) => name === 'electron' ? fakeElectron : name === './shortcut-utils' ? require('../src/shortcut-utils') : { ...client, requestAI: async (_input, _settings, _credentials, { signal }) => new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true })) }, process, AbortController, setTimeout, clearTimeout };
  vm.runInNewContext(fs.readFileSync(require.resolve('../src/zap-main'), 'utf8'), sandbox);
  const runtime = sandbox.module.exports.installZap({ store, getCredentials: async () => credential, handleTrusted: (name, pages, handler) => { assert(pages.every((page) => ['index.html', 'zap-pin.html'].includes(page))); handlers.set(name, handler); }, onTrusted: (name, _pages, handler) => events.set(name, handler), navigate: () => {}, getTypingShortcuts: () => ({ hotkeyStart: 'Alt+5', hotkeyStop: 'Alt+0' }), isTyping: () => false });
  runtime.start(); assert(registered.has('Alt+3')); assert(runtime.conflicts('Alt+3'));
  assert.equal(handlers.has('zap:key'), false);
  const conflict = handlers.get('zap:settings')({}, { ...settings, shortcut: 'Alt+5' }); assert.match(conflict.error, /different shortcut/); assert(registered.has('Alt+3'));
  const sender = new EventEmitter(); const pending = handlers.get('zap:request')({ sender }, input);
  await new Promise((resolve) => setImmediate(resolve));
  const duplicate = await handlers.get('zap:request')({ sender }, input); assert.match(duplicate.error, /already running/);
  events.get('zap:cancel')(); const cancelled = await pending; assert.equal(cancelled.cancelled, true);
  const capture = await handlers.get('zap:capture')({}, '1'); assert.match(capture.error, /Could not capture/);
  runtime.stop(); assert.equal(registered.size, 0);
  console.log('Zap tests passed: server-only provider access, request bounds, subscription checks, concurrent quota, cancellation, shortcuts and capture recovery.');
}
main().catch((error) => { console.error(error); process.exitCode = 1; });
