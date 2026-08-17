const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');
const textTools = require('../src/text-tools');
const proTools = require('../src/pro-tools');
const subscription = require('../src/subscription');
const {
  requestProjectOidcToken,
  resolveBlobAuthentication,
  resolveBlobStoreId,
  resolveBlobToken,
} = require('./publish-update-blobs');

const root = path.resolve(__dirname, '..');
const read = (relativePath) => fs.readFileSync(path.join(root, relativePath), 'utf8');
const fail = (message) => { throw new Error(message); };

const packageJson = JSON.parse(read('package.json'));
const packageLock = JSON.parse(read('package-lock.json'));
const mainSource = read('src/main.js');
const preloadSource = read('src/preload.js');
const quickSource = read('src/quick.js');
const quickMarkup = read('src/quick.html');
const indexMarkup = read('src/index.html');
const subscriptionSource = read('src/subscription.js');
const entitlements = read('build/entitlements.mac.plist');
const releaseWorkflow = read('.github/workflows/release.yml');
const blobPublisher = read('scripts/publish-update-blobs.js');
const websiteBillingSource = read('website/api/_billing.js');
const websiteBilling = require('../website/api/_billing');
const checkoutSource = read('website/api/create-checkout.js');
const claimSource = read('website/api/claim-entitlement.js');
const refreshSource = read('website/api/refresh-entitlement.js');
const portalSource = read('website/api/create-portal.js');
const checkoutStatusSource = read('website/api/checkout-status.js');
const websiteMarkup = read('website/index.html');
const websiteLegal = read('website/legal.html');
const websitePrivacy = read('website/privacy.html');
const websiteTerms = read('website/terms.html');
const websiteRefunds = read('website/refunds.html');

if (!packageJson.private || packageJson.license !== 'UNLICENSED') {
  fail('The package must remain private and proprietary.');
}
if (packageJson.version !== packageLock.version || packageJson.version !== packageLock.packages[''].version) {
  fail('package.json and package-lock.json versions do not match.');
}
for (const [group, dependencies] of Object.entries({
  dependencies: packageJson.dependencies,
  devDependencies: packageJson.devDependencies
})) {
  for (const [name, version] of Object.entries(dependencies || {})) {
    if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(version)) {
      fail(`${group}.${name} must be pinned to an exact version.`);
    }
    if (packageLock.packages['']?.[group]?.[name] !== version) {
      fail(`${group}.${name} does not match the lockfile root.`);
    }
  }
}
if (!packageJson.build?.asar || packageJson.build?.compression !== 'maximum') {
  fail('Production packaging must use maximum-compression ASAR.');
}
if (!packageJson.build?.mac?.forceCodeSigning || !packageJson.build?.mac?.hardenedRuntime) {
  fail('macOS signing and Hardened Runtime must remain mandatory.');
}
if (!entitlements.includes('com.apple.security.cs.allow-jit')) {
  fail('Electron requires the JIT entitlement when Hardened Runtime is enabled.');
}
if (entitlements.includes('com.apple.security.cs.disable-library-validation') ||
    entitlements.includes('com.apple.security.cs.allow-dyld-environment-variables') ||
    entitlements.includes('com.apple.security.cs.allow-unsigned-executable-memory')) {
  fail('Unsafe Hardened Runtime entitlement is enabled.');
}
if (packageJson.build.files.some((entry) => entry.includes('src'))) {
  fail('Raw source must not be included in production packages.');
}
const updateProvider = packageJson.build?.publish?.[0];
if (updateProvider?.provider !== 'generic' || updateProvider?.url !== 'https://drip-type-updates.vercel.app/') {
  fail('The signed updater must use the dedicated public update service.');
}
if (!packageJson.build?.releaseInfo?.releaseName?.includes(packageJson.version) ||
    !packageJson.build?.releaseInfo?.releaseNotes) {
  fail('Release metadata must include the current version name and user-visible notes.');
}

for (const marker of ['launchAtLogin', 'wasOpenedAtLogin', "handleTrusted('clipboard:read-text'"]) {
  if (!mainSource.includes(marker)) fail(`Background composer requirement is missing: ${marker}`);
}
for (const marker of ["hotkeyStart: 'Alt+5'", "store.get('hotkeyStart') === 'Alt+4'", "store.set('hotkeyStart', DEFAULTS.hotkeyStart)"]) {
  if (!mainSource.includes(marker)) fail(`Option+5 composer shortcut migration is missing: ${marker}`);
}
for (const marker of ['autoDownload = false', '6 * 60 * 60 * 1000', 'notifyUpdateAvailable']) {
  if (!mainSource.includes(marker)) fail(`In-app update requirement is missing: ${marker}`);
}
for (const marker of ['app.enableSandbox()', ".replace(/\\r\\n?/g, '\\n')", 'Rejected untrusted IPC sender.']) {
  if (!mainSource.includes(marker)) fail(`Application hardening requirement is missing: ${marker}`);
}
for (const marker of [
  "handleTrusted('billing:get-state'",
  "handleTrusted('billing:refresh'",
  "handleTrusted('billing:portal'",
  'deleteRefreshCredential',
  'shouldRevokeEntitlement(error.status)',
  'paidAccessSeen',
  'navigateMainWindow',
  "window.webContents.once('did-finish-load', navigate)",
  'setAsDefaultProtocolClient(BILLING_SCHEME)',
  'TRIAL_KEYCHAIN_SERVICE',
  "'/usr/bin/security'"
]) {
  if (!mainSource.includes(marker)) fail(`Subscription security requirement is missing: ${marker}`);
}
for (const marker of ['"template_library"', '"batch"', '"writing_lab"', 'STRIPE_PRO_PRICE_ID']) {
  if (!websiteBillingSource.includes(marker)) fail(`Website Pro entitlement requirement is missing: ${marker}`);
}
for (const [name, source] of [
  ['checkout', checkoutSource],
  ['claim', claimSource],
  ['refresh', refreshSource],
  ['portal', portalSource],
  ['checkout status', checkoutStatusSource]
]) {
  if (!source.includes('hasExactKeys')) fail(`Website ${name} API must reject unexpected fields.`);
}
for (const marker of ['Pro is live in version 1.6', 'data-checkout-plan="pro"', '>$25<', '/brand/zap/zap-icon.svg']) {
  if (!websiteMarkup.includes(marker)) fail(`Website Pro launch requirement is missing: ${marker}`);
}
for (const marker of [
  'Typing speed', 'Start delay', 'Corrected typos', 'Thinking pauses', 'Speed bursts',
  'data-rhythm-preset="steady"', 'data-rhythm-preset="natural"',
  'data-rhythm-preset="expressive"', 'What ships today', 'Signed + notarized'
]) {
  if (!websiteMarkup.includes(marker)) fail(`Website verified-product showcase is missing: ${marker}`);
}
if (websiteMarkup.includes('Pause instantly')) {
  fail('Website must not claim a pause/resume control that the application does not provide.');
}
if (!websiteMarkup.includes('name="google-site-verification"')) {
  fail('Google Search Console ownership verification must remain in the production homepage.');
}
for (const marker of ['/legal', 'renew monthly until canceled', 'By completing checkout', '/privacy', '/terms', '/refunds']) {
  if (!websiteMarkup.includes(marker)) fail(`Website legal disclosure is missing: ${marker}`);
}
for (const [name, source, markers] of [
  ['legal center', websiteLegal, ['VegaNext LLC', 'support@tryzap.net', 'Subscription summary', '/privacy', '/terms', '/refunds']],
  ['privacy policy', websitePrivacy, ['Effective August 16, 2026', 'Information we collect and why', 'We do not sell personal information', 'Your privacy rights', '400 Continental Blvd']],
  ['terms', websiteTerms, ['Effective August 16, 2026', 'Paid subscriptions and renewal', 'up to three Macs', 'Governing law and disputes', 'These Terms do not require arbitration']],
  ['refund policy', websiteRefunds, ['Effective August 16, 2026', 'Cancel online at any time', '14 calendar days', 'Renewal charges and partial periods', 'support@tryzap.net']]
]) {
  for (const marker of markers) {
    if (!source.includes(marker)) fail(`Website ${name} requirement is missing: ${marker}`);
  }
}
for (const marker of [
  "handleTrusted('pro:batch-render'", "handleTrusted('pro:transform'",
  "handleTrusted('profiles:save'", "handleTrusted('clipboard-workspace:capture'",
  "proRequired('clipboard')", 'MAX_CLIPBOARD_COUNT'
]) {
  if (!mainSource.includes(marker)) fail(`Pro enforcement requirement is missing: ${marker}`);
}
for (const marker of ['ENTITLEMENT_PUBLIC_KEY', 'createPublicKey', 'verifyEntitlement', 'deviceHash']) {
  if (!subscriptionSource.includes(marker)) fail(`Signed entitlement verification is missing: ${marker}`);
}
for (const marker of ['id="page-billing"', 'id="billing-status"', 'id="billing-manage"']) {
  if (!indexMarkup.includes(marker)) fail(`Native billing interface is missing: ${marker}`);
}
if (/uses:\s+[^\n]+@(v\d+|main|master|latest)\b/.test(releaseWorkflow) ||
    /vercel@latest\b/.test(releaseWorkflow)) {
  fail('Release dependencies must be pinned to immutable versions.');
}
if (releaseWorkflow.includes('git fetch') ||
    !releaseWorkflow.includes('git rev-parse refs/remotes/origin/main') ||
    !releaseWorkflow.includes('RELEASE_TAG="${RELEASE_TAG%%/*}"') ||
    !releaseWorkflow.includes('RELEASE_TAG="${RELEASE_TAG%%-retry-*}"')) {
  fail('Release validation must use the credential-free checkout and support an isolated retry branch.');
}
for (const marker of [
  'vercel@58.9.1 env pull',
  'node --env-file="$RUNNER_TEMP/drip-type-updates.env" scripts/publish-update-blobs.js',
  'cp dist/latest-mac.yml update-site/'
]) {
  if (!releaseWorkflow.includes(marker)) fail(`Release Blob publishing requirement is missing: ${marker}`);
}
if (releaseWorkflow.includes('cp dist/latest-mac.yml dist/*.dmg')) {
  fail('Large installers must not be copied into the Vercel deployment.');
}
for (const marker of [
  "access: 'public'",
  'multipart: true',
  'cacheControlMaxAge: 31536000',
  "crypto.createHash('sha256')",
  '`releases/v${packageVersion}/${digest}/${name}`',
  'requestProjectOidcToken',
  'resolveBlobAuthentication',
  'resolveBlobStoreId'
]) {
  if (!blobPublisher.includes(marker)) fail(`Blob publisher requirement is missing: ${marker}`);
}

assert.equal(
  resolveBlobToken({ BLOB_READ_WRITE_TOKEN: ' vercel_blob_rw_store_secret ' }),
  'vercel_blob_rw_store_secret',
);
assert.equal(
  resolveBlobToken({ DRIP_TYPE_BLOB_READ_WRITE_TOKEN: ' vercel_blob_rw_store_prefixed ' }),
  'vercel_blob_rw_store_prefixed',
);
assert.throws(
  () => resolveBlobToken({
    FIRST_BLOB_READ_WRITE_TOKEN: 'vercel_blob_rw_store_one',
    SECOND_BLOB_READ_WRITE_TOKEN: 'vercel_blob_rw_store_two',
  }),
  /multiple read-write token variables are configured/,
);
assert.throws(() => resolveBlobToken({}), /no Blob read-write token is configured/);
assert.equal(resolveBlobStoreId({ BLOB_STORE_ID: ' store_main ' }), 'store_main');
assert.equal(resolveBlobStoreId({ DRIP_TYPE_BLOB_STORE_ID: ' store_prefixed ' }), 'store_prefixed');
assert.equal(resolveBlobStoreId({ BLOB_STORE_ID: 'same', OTHER_BLOB_STORE_ID: 'same' }), 'same');
assert.throws(
  () => resolveBlobStoreId({ FIRST_BLOB_STORE_ID: 'first', SECOND_BLOB_STORE_ID: 'second' }),
  /multiple Blob store IDs are configured/,
);

resolveBlobAuthentication({
  BLOB_STORE_ID: 'production-store',
  VERCEL_OIDC_TOKEN: 'production-oidc',
  VERCEL_TOKEN: 'long-lived-token-must-not-be-used',
}).then((authentication) => {
  assert.deepEqual(authentication, {
    oidcToken: 'production-oidc',
    storeId: 'production-store',
  });
}).catch((error) => {
  setImmediate(() => { throw error; });
});

const oidcRequests = [];
requestProjectOidcToken(
  { accessToken: 'secret-vercel-token', projectId: 'prj_test', orgId: 'team_test' },
  async (url, options) => {
    oidcRequests.push({ url: String(url), options });
    return { ok: true, status: 200, json: async () => ({ token: 'short-lived-oidc' }) };
  },
).then((token) => {
  assert.equal(token, 'short-lived-oidc');
  assert.equal(oidcRequests.length, 1);
  assert(oidcRequests[0].url.includes('/v1/projects/prj_test/token'));
  assert(oidcRequests[0].url.includes('teamId=team_test'));
  assert.equal(oidcRequests[0].options.method, 'POST');
  assert.equal(oidcRequests[0].options.headers.authorization, 'Bearer secret-vercel-token');
}).catch((error) => {
  setImmediate(() => { throw error; });
});

const blobTestRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'dt-update-publish-test-'));
try {
  const blobTestDist = path.join(blobTestRoot, 'dist');
  const blobTestSite = path.join(blobTestRoot, 'site');
  fs.mkdirSync(blobTestDist);
  for (const name of [
    `Drip-Type-${packageJson.version}-mac.dmg`,
    `Drip-Type-${packageJson.version}-mac.dmg.blockmap`,
    `Drip-Type-${packageJson.version}-mac.zip`,
    `Drip-Type-${packageJson.version}-mac.zip.blockmap`
  ]) {
    fs.writeFileSync(path.join(blobTestDist, name), `fixture:${name}`);
  }
  execFileSync(process.execPath, ['scripts/publish-update-blobs.js'], {
    cwd: root,
    env: {
      ...process.env,
      DIST_DIR: blobTestDist,
      UPDATE_SITE_DIR: blobTestSite,
      PUBLISH_UPDATE_DRY_RUN: '1'
    },
    stdio: 'pipe'
  });
  const generatedConfig = JSON.parse(fs.readFileSync(path.join(blobTestSite, 'vercel.json'), 'utf8'));
  assert.equal(generatedConfig.redirects.length, 4);
  assert(generatedConfig.redirects.every(({ destination }) =>
    destination.startsWith(`https://dry-run.invalid/releases/v${packageJson.version}/`)));
} finally {
  fs.rmSync(blobTestRoot, { recursive: true, force: true });
}
if (!preloadSource.includes("ipcRenderer.invoke('clipboard:read-text')")) {
  fail('The isolated clipboard bridge is missing.');
}
for (const marker of ["ipcRenderer.invoke('templates:list')", "ipcRenderer.invoke('templates:save'", "ipcRenderer.invoke('templates:delete'"]) {
  if (!preloadSource.includes(marker)) fail(`The isolated template bridge is missing: ${marker}`);
}
for (const marker of [
  "ipcRenderer.invoke('billing:get-state')",
  "ipcRenderer.invoke('billing:refresh')",
  "ipcRenderer.invoke('billing:portal')",
  "ipcRenderer.on('billing:state'"
]) {
  if (!preloadSource.includes(marker)) fail(`The isolated billing bridge is missing: ${marker}`);
}
for (const marker of ['Drip Composer', 'Private draft · stored in memory only', 'id="paste"']) {
  if (!quickMarkup.includes(marker)) fail(`Composer interface requirement is missing: ${marker}`);
}
if (!quickSource.includes('readClipboardText') || !quickSource.includes('100000')) {
  fail('Composer clipboard input must use the bounded preload bridge.');
}
for (const marker of ['MAX_CORE_TEMPLATE_COUNT', 'MAX_PRO_TEMPLATE_COUNT', "handleTrusted('templates:list'", 'sanitizeTemplate']) {
  if (!mainSource.includes(marker)) fail(`Local template safety requirement is missing: ${marker}`);
}
for (const marker of ['template-picker', 'template-dialog', 'tool-clean', 'tool-bullets']) {
  if (!quickMarkup.includes(`id="${marker}"`)) fail(`Composer local tool is missing: ${marker}`);
}

assert.equal(textTools.cleanSpacing('  Hello   world  \r\n\r\n\r\n Next  '), 'Hello world\n\nNext');
const bulleted = textTools.toggleBulletsText('One\nTwo');
assert.deepEqual(bulleted, { added: true, text: '• One\n• Two' });
assert.deepEqual(textTools.toggleBulletsText(bulleted.text), { added: false, text: 'One\nTwo' });
assert.deepEqual(textTools.variableNames('Hi {{ name }}, {{topic}} / {{name}}'), ['name', 'topic']);
assert.equal(textTools.fillTemplate('Hi {{name}} — {{topic}}', { name: 'Sam', topic: 'launch' }), 'Hi Sam — launch');
assert.equal(textTools.hasUnresolvedVariables('Hi {{name}}'), true);
assert.equal(textTools.hasUnresolvedVariables('Hi Sam'), false);
const batch = proTools.renderBatch('Hi {{name}} — {{topic}}', 'name,topic\nSam,Launch\nMaya,"Quarterly, plan"');
assert.deepEqual(batch.outputs.map(({ text }) => text), ['Hi Sam — Launch', 'Hi Maya — Quarterly, plan']);
assert.equal(proTools.renderBatch('Hi {{name}}', 'person\nSam').outputs.length, 0);
assert.match(proTools.renderBatch('Hi {{name}}', 'person\nSam').errors[0], /Missing columns/);
assert.equal(proTools.transformWriting('I just wanted to maybe share this.', 'direct'), 'share this.');
assert.equal(proTools.transformWriting('One. Two?', 'outline'), '• One.\n• Two?');
assert.deepEqual(proTools.searchClipboard([{ text: 'Launch note' }, { text: 'Invoice' }], 'launch'), [{ text: 'Launch note' }]);

const trialStart = Date.now() - 2 * 24 * 60 * 60 * 1000;
const trialState = subscription.accessState({
  token: '',
  deviceId: '3b9d5ef5-b71a-4cc0-a3aa-5ad5da015a2b',
  trialStartedAt: trialStart,
  now: Date.now()
});
assert.equal(trialState.allowed, true);
assert.equal(trialState.status, 'trial');
assert.equal(trialState.daysRemaining, 12);
const expiredTrialState = subscription.accessState({
  token: '',
  deviceId: '3b9d5ef5-b71a-4cc0-a3aa-5ad5da015a2b',
  trialStartedAt: trialStart - subscription.TRIAL_LENGTH_MS,
  now: Date.now()
});
assert.equal(expiredTrialState.allowed, false);
assert.equal(expiredTrialState.status, 'required');
assert.equal(subscription.shouldRevokeEntitlement(401), true);
assert.equal(subscription.shouldRevokeEntitlement(402), true);
assert.equal(subscription.shouldRevokeEntitlement(403), true);
assert.equal(subscription.shouldRevokeEntitlement(409), false);
assert.equal(subscription.shouldRevokeEntitlement(503), false);

assert.deepEqual(
  websiteBilling.parseBody({ body: '{"plan":"pro"}' }, 64),
  { plan: 'pro' },
);
assert.equal(websiteBilling.hasExactKeys({ plan: 'pro' }, ['plan']), true);
assert.equal(websiteBilling.hasExactKeys({ plan: 'pro', admin: true }, ['plan']), false);
assert.equal(websiteBilling.hasExactKeys({ sessionId: 'one' }, ['sessionId', 'deviceId']), false);
assert.equal(websiteBilling.isJsonRequest({ headers: { 'content-type': 'application/json; charset=utf-8' } }), true);
assert.equal(websiteBilling.isJsonRequest({ headers: { 'content-type': 'text/plain' } }), false);
assert.throws(() => websiteBilling.parseBody({ body: '[]' }), /JSON object/);
assert.throws(() => websiteBilling.parseBody({ body: { plan: 'pro', data: 'x'.repeat(80) } }, 64), /too large/);

const { privateKey: testPrivateKey, publicKey: testPublicKey } = crypto.generateKeyPairSync('ed25519');
const nowSeconds = Math.floor(Date.now() / 1000);
const testDevice = '3b9d5ef5-b71a-4cc0-a3aa-5ad5da015a2b';
const testHeader = Buffer.from(JSON.stringify({ alg: 'EdDSA', kid: 'drip-type-v1', typ: 'JWT' })).toString('base64url');
const testPayload = Buffer.from(JSON.stringify({
  v: 1,
  iss: 'https://tryzap.net',
  aud: 'com.salt30.driptype',
  sub: 'test-subscription',
  plan: 'core',
  features: ['composer', 'typing', 'hotkeys', 'templates', 'updates'],
  device: subscription.deviceHash(testDevice),
  iat: nowSeconds,
  exp: nowSeconds + 60 * 60
})).toString('base64url');
const testInput = `${testHeader}.${testPayload}`;
const testSignature = crypto.sign(null, Buffer.from(testInput), testPrivateKey).toString('base64url');
const testToken = `${testInput}.${testSignature}`;
const testPublicKeyEncoded = testPublicKey.export({ format: 'der', type: 'spki' }).toString('base64');
assert.equal(subscription.verifyEntitlement(testToken, testDevice, Date.now(), testPublicKeyEncoded).plan, 'core');
const proPayload = Buffer.from(JSON.stringify({
  ...JSON.parse(Buffer.from(testPayload, 'base64url').toString('utf8')),
  plan: 'pro',
  features: ['composer', 'typing', 'hotkeys', 'templates', 'updates', 'profiles', 'clipboard', 'template_library', 'batch', 'writing_lab']
})).toString('base64url');
const proInput = `${testHeader}.${proPayload}`;
const proSignature = crypto.sign(null, Buffer.from(proInput), testPrivateKey).toString('base64url');
const proEntitlement = subscription.verifyEntitlement(`${proInput}.${proSignature}`, testDevice, Date.now(), testPublicKeyEncoded);
assert.equal(proEntitlement.plan, 'pro');
assert.equal(proEntitlement.features.includes('batch'), true);
const previousSigningKey = process.env.ENTITLEMENT_PRIVATE_KEY;
process.env.ENTITLEMENT_PRIVATE_KEY = testPrivateKey.export({ format: 'der', type: 'pkcs8' }).toString('base64');
const issuedPro = websiteBilling.signedEntitlement({ id: 'sub_live_pro_fixture' }, 'pro', testDevice);
const verifiedIssuedPro = subscription.verifyEntitlement(issuedPro.token, testDevice, Date.now(), testPublicKeyEncoded);
assert.equal(verifiedIssuedPro.plan, 'pro');
assert.deepEqual(verifiedIssuedPro.features, [
  'composer', 'typing', 'hotkeys', 'templates', 'updates', 'profiles', 'clipboard',
  'template_library', 'batch', 'writing_lab'
]);
if (previousSigningKey === undefined) delete process.env.ENTITLEMENT_PRIVATE_KEY;
else process.env.ENTITLEMENT_PRIVATE_KEY = previousSigningKey;
const tamperedPayload = Buffer.from(JSON.stringify({
  ...JSON.parse(Buffer.from(testPayload, 'base64url').toString('utf8')),
  plan: 'pro'
})).toString('base64url');
assert.throws(
  () => subscription.verifyEntitlement(`${testHeader}.${tamperedPayload}.${testSignature}`, testDevice, Date.now(), testPublicKeyEncoded),
  /Invalid entitlement signature/
);

const pages = [
  ['src/index.html', 'src/index.js'],
  ['src/quick.html', 'src/quick.js'],
  ['src/onboarding.html', 'src/onboarding.js']
];

for (const [htmlPath, jsPath] of pages) {
  const html = read(htmlPath);
  const js = read(jsPath);
  const ids = [...html.matchAll(/\bid="([^"]+)"/g)].map((match) => match[1]);
  if (new Set(ids).size !== ids.length) fail(`${htmlPath} contains a duplicate element ID.`);

  const csp = html.match(/Content-Security-Policy" content="([^"]+)"/)?.[1] || '';
  if (!csp.includes("default-src 'self'") || !csp.includes("script-src 'self'") ||
      !csp.includes("connect-src 'none'") || csp.includes("'unsafe-eval'")) {
    fail(`${htmlPath} has an unsafe or incomplete Content Security Policy.`);
  }
  if (/<script(?!\s+src=)[^>]*>/i.test(html)) fail(`${htmlPath} contains an inline script.`);

  const referencedIds = [
    ...js.matchAll(/\$\('([^']+)'\)/g),
    ...js.matchAll(/getElementById\('([^']+)'\)/g)
  ].map((match) => match[1]);
  for (const id of referencedIds) {
    if (!ids.includes(id)) fail(`${jsPath} references missing element #${id}.`);
  }
}

const forbiddenExtensions = new Set(['.p12', '.pfx', '.cer', '.pem', '.key', '.mobileprovision']);
const forbiddenNames = new Set(['.env', '.env.local', '.npmrc', 'project.json']);
const excludedDirectories = new Set(['node_modules', 'dist', 'build-app', '.git']);
const secretPatterns = [
  ['Stripe live key', new RegExp(['[rs]k', 'live', '[A-Za-z0-9_]{16,}'].join('[_]'))],
  ['Stripe webhook secret', new RegExp(['whsec', '[A-Za-z0-9]{16,}'].join('[_]'))],
  ['GitHub token', /\bgh[pousr]_[A-Za-z0-9]{30,}\b/],
  ['AWS access key', /AKIA[0-9A-Z]{16}/],
  ['private key', new RegExp(['-----BEGIN', '(?: RSA| EC| OPENSSH)?', ' PRIVATE KEY-----'].join(''))],
  ['Apple app-specific password', /\b[a-z]{4}(?:-[a-z]{4}){3}\b/]
];
const textExtensions = new Set(['', '.cjs', '.css', '.html', '.js', '.json', '.md', '.mjs', '.plist', '.sh', '.txt', '.yml', '.yaml']);
function scan(directory) {
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    if (excludedDirectories.has(entry.name)) continue;
    const absolutePath = path.join(directory, entry.name);
    if (entry.isDirectory()) scan(absolutePath);
    else {
      const relativePath = path.relative(root, absolutePath);
      const extension = path.extname(entry.name).toLowerCase();
      if (forbiddenExtensions.has(extension) || forbiddenNames.has(entry.name)) {
        fail(`Credential material must not be stored in the repository: ${relativePath}`);
      }
      if (!textExtensions.has(extension) || fs.statSync(absolutePath).size > 2_000_000) continue;
      const source = fs.readFileSync(absolutePath, 'utf8').replace(/xxxx-xxxx-xxxx-xxxx/g, '');
      for (const [label, pattern] of secretPatterns) {
        if (pattern.test(source)) fail(`${label} detected in ${relativePath}.`);
      }
    }
  }
}
scan(root);

console.log('Source, UI, security, and packaging configuration verification passed.');
