const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const read = (relativePath) => fs.readFileSync(path.join(root, relativePath), 'utf8');
const fail = (message) => { throw new Error(message); };

const packageJson = JSON.parse(read('package.json'));
const packageLock = JSON.parse(read('package-lock.json'));
const mainSource = read('src/main.js');
const preloadSource = read('src/preload.js');
const quickSource = read('src/quick.js');
const quickMarkup = read('src/quick.html');

if (!packageJson.private || packageJson.license !== 'UNLICENSED') {
  fail('The package must remain private and proprietary.');
}
if (packageJson.version !== packageLock.version || packageJson.version !== packageLock.packages[''].version) {
  fail('package.json and package-lock.json versions do not match.');
}
if (!packageJson.build?.asar || packageJson.build?.compression !== 'maximum') {
  fail('Production packaging must use maximum-compression ASAR.');
}
if (!packageJson.build?.mac?.forceCodeSigning || !packageJson.build?.mac?.hardenedRuntime) {
  fail('macOS signing and Hardened Runtime must remain mandatory.');
}
if (packageJson.build.files.some((entry) => entry.includes('src'))) {
  fail('Raw source must not be included in production packages.');
}

for (const marker of ['launchAtLogin', 'wasOpenedAtLogin', "handleTrusted('clipboard:read-text'"]) {
  if (!mainSource.includes(marker)) fail(`Background composer requirement is missing: ${marker}`);
}
if (!preloadSource.includes("ipcRenderer.invoke('clipboard:read-text')")) {
  fail('The isolated clipboard bridge is missing.');
}
for (const marker of ['Drip Composer', 'Private draft · stored in memory only', 'id="paste"']) {
  if (!quickMarkup.includes(marker)) fail(`Composer interface requirement is missing: ${marker}`);
}
if (!quickSource.includes('readClipboardText') || !quickSource.includes('100000')) {
  fail('Composer clipboard input must use the bounded preload bridge.');
}

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

const forbiddenExtensions = new Set(['.p12', '.pfx', '.cer', '.pem', '.key']);
const excludedDirectories = new Set(['node_modules', 'dist', 'build-app', '.git']);
function scan(directory) {
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    if (excludedDirectories.has(entry.name)) continue;
    const absolutePath = path.join(directory, entry.name);
    if (entry.isDirectory()) scan(absolutePath);
    else if (forbiddenExtensions.has(path.extname(entry.name).toLowerCase())) {
      fail(`Credential material must not be stored in the repository: ${path.relative(root, absolutePath)}`);
    }
  }
}
scan(root);

console.log('Source, UI, security, and packaging configuration verification passed.');
