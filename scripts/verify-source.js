const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const textTools = require('../src/text-tools');

const root = path.resolve(__dirname, '..');
const read = (relativePath) => fs.readFileSync(path.join(root, relativePath), 'utf8');
const fail = (message) => { throw new Error(message); };

const packageJson = JSON.parse(read('package.json'));
const packageLock = JSON.parse(read('package-lock.json'));
const mainSource = read('src/main.js');
const preloadSource = read('src/preload.js');
const quickSource = read('src/quick.js');
const quickMarkup = read('src/quick.html');
const entitlements = read('build/entitlements.mac.plist');
const releaseWorkflow = read('.github/workflows/release.yml');

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
if (entitlements.includes('com.apple.security.cs.disable-library-validation') ||
    entitlements.includes('com.apple.security.cs.allow-dyld-environment-variables') ||
    entitlements.includes('com.apple.security.cs.allow-unsigned-executable-memory') ||
    entitlements.includes('com.apple.security.cs.allow-jit')) {
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
for (const marker of ['autoDownload = false', '6 * 60 * 60 * 1000', 'notifyUpdateAvailable']) {
  if (!mainSource.includes(marker)) fail(`In-app update requirement is missing: ${marker}`);
}
for (const marker of ['app.enableSandbox()', ".replace(/\\r\\n?/g, '\\n')", 'Rejected untrusted IPC sender.']) {
  if (!mainSource.includes(marker)) fail(`Application hardening requirement is missing: ${marker}`);
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
if (!preloadSource.includes("ipcRenderer.invoke('clipboard:read-text')")) {
  fail('The isolated clipboard bridge is missing.');
}
for (const marker of ["ipcRenderer.invoke('templates:list')", "ipcRenderer.invoke('templates:save'", "ipcRenderer.invoke('templates:delete'"]) {
  if (!preloadSource.includes(marker)) fail(`The isolated template bridge is missing: ${marker}`);
}
for (const marker of ['Drip Composer', 'Private draft · stored in memory only', 'id="paste"']) {
  if (!quickMarkup.includes(marker)) fail(`Composer interface requirement is missing: ${marker}`);
}
if (!quickSource.includes('readClipboardText') || !quickSource.includes('100000')) {
  fail('Composer clipboard input must use the bounded preload bridge.');
}
for (const marker of ['MAX_TEMPLATE_COUNT', "handleTrusted('templates:list'", 'sanitizeTemplate']) {
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
