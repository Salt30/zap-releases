const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const crypto = require('node:crypto');
const { createAccountSession } = require('../src/account-session');
const { memoryBlob } = require('./mock-blob');
const deviceId = '3b9d5ef5-b71a-4cc0-a3aa-5ad5da015a2b';
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
function fixture(overrides = {}) {
  const data = new Map([['entitlementToken', 'old-entitlement']]);
  const store = { get: (k,d) => data.has(k) ? data.get(k) : d, set: (k,v) => data.set(k,v) };
  let credential = 'sub_fixture.' + 'a'.repeat(43), opened = '', resets = 0;
  const session = createAccountSession({ store, deviceId: () => deviceId,
    readCredential: async () => credential, saveCredential: async value => { credential = value; }, deleteCredential: async () => { credential = ''; },
    validateEntitlement: token => { if (token !== 'new-entitlement') throw new Error('bad signature'); },
    request: async () => ({ entitlement: 'new-entitlement', refreshToken: 'sub_fixture.' + 'b'.repeat(43) }),
    openBrowser: async url => { opened = url; }, onSignOut: () => resets++, publish: patch => ({ signedIn: !store.get('accountSignedOut',false), ...patch }), ...overrides });
  return { session, data, credential: () => credential, opened: () => new URL(opened), resets: () => resets };
}
const activation = state => `a.${Buffer.from(JSON.stringify({state})).toString('base64url')}.b`;
(async () => {
  const f = fixture();
  await assert.rejects(f.session.activate(activation('unexpected')), /Start Sign in/);
  await f.session.beginSignIn(); const state = f.opened().searchParams.get('connect_state');
  assert.equal(f.opened().origin, 'https://tryzap.net');
  assert.match(f.opened().searchParams.get('connect_challenge'), /^[A-Za-z0-9_-]{43}$/);
  await assert.rejects(f.session.activate(activation('wrong')), /Start Sign in/);
  await f.session.activate(activation(state));
  assert.equal(f.data.get('entitlementToken'),'new-entitlement');
  await assert.rejects(f.session.activate(activation(state)), /Start Sign in/);
  await f.session.signOut(); assert.equal(f.credential(),''); assert.equal(f.data.get('entitlementToken'),''); assert.equal(f.resets(),1);
  assert.equal((await f.session.credentials()).refreshToken,'');

  const late = deferred(); const r = fixture({ request: async path => path === '/api/refresh-entitlement' ? late.promise : {} });
  const refresh = r.session.refresh(); await new Promise(setImmediate); await r.session.signOut(); late.resolve({entitlement:'new-entitlement'}); await refresh;
  assert.equal(r.data.get('entitlementToken'),'','Late refresh restored signed-out access');
  const claim = deferred(); const a = fixture({ request: async path => path === '/api/claim-account-entitlement' ? claim.promise : {} });
  await a.session.beginSignIn(); const accepting = a.session.activate(activation(a.opened().searchParams.get('connect_state')));
  await a.session.signOut(); claim.resolve({entitlement:'new-entitlement',refreshToken:'sub_fixture.'+'b'.repeat(43)}); await accepting;
  assert.equal(a.credential(),'','Late activation restored a credential');
  const offline = fixture({ request: async () => {throw new Error('network offline');} });
  assert.match((await offline.session.signOut()).warning,/server could not confirm/); assert.equal(offline.credential(),'');
  const failedDelete = fixture({deleteCredential: async()=>{throw new Error('OS denied');}});
  assert.match((await failedDelete.session.signOut()).warning,/storage cleanup/); assert.equal(failedDelete.data.get('accountCleanupPending'),true);
  assert.equal((await failedDelete.session.credentials()).refreshToken,'','Leftover OS credential bypassed sign-out');
  const storing = deferred(); let saveStarted = false;
  const saving = fixture({ saveCredential: async () => { saveStarted = true; await storing.promise; } });
  await saving.session.beginSignIn();
  const finishing = saving.session.activate(activation(saving.opened().searchParams.get('connect_state')));
  await new Promise(setImmediate); assert.equal(saveStarted,true);
  const logoutDuringSave = saving.session.signOut(); storing.resolve();
  await Promise.all([finishing,logoutDuringSave]);
  assert.equal(saving.data.get('entitlementToken'),'','An OS storage write restored access after logout');

  // Real session-signing/encryption code, with only Blob I/O replaced.
  const storage=memoryBlob();const module={exports:{}};
  const context={module,exports:module.exports,Buffer,URL,URLSearchParams,Response,structuredClone,process:{env:{AUTH_MASTER_KEY:Buffer.alloc(32,19).toString('base64url'),BLOB_STORE_ID:'store_fixture'}},require:name=>name==='@vercel/blob'?{...storage,BlobPreconditionFailedError:class extends Error{}}:require(name)};
  vm.runInNewContext(fs.readFileSync(require.resolve('../website/server/accounts'),'utf8'),context);
  const accounts=module.exports;
  const created=await accounts.createAccount('auth-fixture@example.com','Secret fixture password 935!');
  const oldCookie={headers:{cookie:`${accounts.COOKIE_NAME}=${accounts.sessionToken(created.account)}`}};
  const otherCookie={headers:{cookie:`${accounts.COOKIE_NAME}=${accounts.sessionToken(created.account)}`}};
  assert.ok(await accounts.accountForRequest(oldCookie));
  await accounts.revokeSession(oldCookie);
  assert.equal(await accounts.accountForRequest(oldCookie),null,'A copied cookie remained usable after logout');
  assert.ok(await accounts.accountForRequest(otherCookie),'Logout unnecessarily revoked a different browser session');
  await accounts.revokeSession(oldCookie); assert.equal(await accounts.accountForRequest(oldCookie),null);

  const router = require('../website/api/account');
  const liveAccounts = require('../website/server/accounts');
  const rate = require('../website/server/rate-limit');
  const originalConsume = rate.consume, originalRevoke = liveAccounts.revokeSession;
  const oldOrigin = process.env.PUBLIC_SITE_URL;
  process.env.PUBLIC_SITE_URL='https://tryzap.net'; rate.consume=async()=>({allowed:true});
  const res = () => ({ headers:{}, setHeader(k,v){this.headers[k]=v;},status(code){this.code=code;return this;},json(body){this.body=body;return this;} });
  const req = origin => ({method:'POST',headers:{origin,'content-type':'application/json','sec-fetch-site':'same-origin'},body:{},socket:{remoteAddress:'127.0.0.1'}});
  try {
    let calls=0; liveAccounts.revokeSession=async()=>{calls++;};
    let response=res();await router.routes.logout(req('https://evil.example'),response);assert.equal(response.code,403);assert.equal(calls,0);
    response=res();await router.routes.logout(req('https://tryzap.net'),response);assert.equal(response.code,200);assert.match(response.headers['Set-Cookie'],/Max-Age=0.*HttpOnly.*Secure/);
    liveAccounts.revokeSession=async()=>{throw new Error('private storage error');};
    response=res();await router.routes.logout(req('https://tryzap.net'),response);assert.equal(response.code,503);assert.doesNotMatch(JSON.stringify(response.body),/private storage/);
    response=res();await router.routes.disconnect(req('https://tryzap.net'),response);assert.equal(response.code,400);
  } finally { rate.consume=originalConsume;liveAccounts.revokeSession=originalRevoke;if(oldOrigin===undefined)delete process.env.PUBLIC_SITE_URL;else process.env.PUBLIC_SITE_URL=oldOrigin; }

  const billing=require('../website/api/_billing');
  const pair=crypto.generateKeyPairSync('ed25519'); const previous=process.env.ENTITLEMENT_PRIVATE_KEY;
  process.env.ENTITLEMENT_PRIVATE_KEY=pair.privateKey.export({format:'der',type:'pkcs8'}).toString('base64');
  const verifier=crypto.randomBytes(32).toString('base64url'); const challenge=crypto.createHash('sha256').update(verifier).digest('base64url');
  const sub={id:'sub_fixture',status:'active',metadata:{dt_d1:crypto.createHash('sha256').update(deviceId).digest('base64url').slice(0,40),dt_r1:crypto.createHash('sha256').update('a'.repeat(43)).digest('base64url')},items:{data:[{price:{id:'price_fixture'}}]}};
  const signed=billing.signedAppActivation({userId:created.account.accountId},sub,'core',deviceId,state,challenge);
  await assert.rejects(billing.subscriptionForAppActivation(signed,deviceId),/Invalid activation proof/);
  await assert.rejects(billing.subscriptionForAppActivation(signed,deviceId,'x'.repeat(43)),/Invalid activation proof/);
  const originalFetch=global.fetch;let mutations=[];
  global.fetch=async(_url,opts={})=>{if(opts.method==='POST'){mutations.push(opts.body);sub.metadata={};}return{ok:true,status:200,json:async()=>sub};};
  const oldStripe=process.env.STRIPE_SECRET_KEY,oldPrice=process.env.STRIPE_CORE_PRICE_ID;
  process.env.STRIPE_SECRET_KEY='sk_live_'+'a'.repeat(32);process.env.STRIPE_CORE_PRICE_ID='price_fixture';
  try {
    await billing.subscriptionForAppActivation(signed,deviceId,verifier);
    await billing.revokeRefreshCredential('sub_fixture.'+'a'.repeat(43),'4b9d5ef5-b71a-4cc0-a3aa-5ad5da015a2b');assert.equal(mutations.length,0);
    await billing.revokeRefreshCredential('sub_fixture.'+'a'.repeat(43),deviceId);assert.equal(mutations.length,1);
    assert.equal(mutations[0].get('metadata[dt_r1]'),'');
    await assert.rejects(billing.subscriptionForRefresh('sub_fixture.'+'a'.repeat(43),deviceId),/rejected/);
  } finally {global.fetch=originalFetch;for(const[k,v]of Object.entries({ENTITLEMENT_PRIVATE_KEY:previous,STRIPE_SECRET_KEY:oldStripe,STRIPE_CORE_PRICE_ID:oldPrice})){if(v===undefined)delete process.env[k];else process.env[k]=v;}}
  console.log('Account security passed: browser binding, PKCE, replay rejection, stale responses, local cleanup, offline logout, cookie invalidation and device revocation.');
})().catch(error=>{console.error(error);process.exitCode=1});
