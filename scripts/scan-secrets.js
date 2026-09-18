// Redacted scan: only location, detector and fingerprint are emitted.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');
const asar = require('@electron/asar');
const root = path.resolve(__dirname, '..');
const patterns = [
  ['NVIDIA key', /nvapi-[A-Za-z0-9_-]{40,200}/g],
  ['Groq key', /gsk_[A-Za-z0-9]{40,}/g],
  ['Cerebras key', /csk-[A-Za-z0-9_-]{40,}/g],
  ['Stripe secret', /(?:sk|rk)_(?:live|test)_[A-Za-z0-9]{20,}/g],
  ['Stripe webhook secret', /whsec_[A-Za-z0-9]{20,}/g],
  ['AI provider key', /sk-(?:proj-|ant-api\d+-)?[A-Za-z0-9_-]{32,}/g],
  ['GitHub token', /(?:ghp_[A-Za-z0-9]{36}|github_pat_[A-Za-z0-9_]{50,})/g],
  ['Vercel Blob token', /vercel_blob_rw_[A-Za-z0-9_-]{30,}/g],
  ['AWS access key', /AKIA[0-9A-Z]{16}/g],
  ['Google API key', /AIza[A-Za-z0-9_-]{35}/g],
  ['Slack token', /xox[baprs]-[A-Za-z0-9-]{20,}/g],
  ['private key', /-----BEGIN (?:RSA |EC |OPENSSH |ENCRYPTED )?PRIVATE KEY-----/g],
  ['assigned credential', /(?:AUTH_MASTER_KEY|ENTITLEMENT_PRIVATE_KEY|NVIDIA_API_KEY|STRIPE_SECRET_KEY|CRON_SECRET|SUPPORT_ENCRYPTION_KEY)\s*[=:]\s*["']?([A-Za-z0-9_+/=-]{32,})/g],
];
const findings = []; const fingerprints = new Set();
let scanned = 0;
function inspect(buffer, location) {
  scanned++;
  const text = buffer.toString('utf8');
  for (const [label, pattern] of patterns) {
    pattern.lastIndex = 0;
    for (const match of text.matchAll(pattern)) {
      const token = match[1] || match[0];
      // Synthetic repeated-character fixtures carry no usable credential.
      if (label !== 'private key' && new Set(token.replace(/^(?:nvapi-|sk_live_|sk_test_)/, '')).size < 8) continue;
      const fingerprint = crypto.createHash('sha256').update(token).digest('hex').slice(0, 12);
      const line = text.slice(0, match.index).split('\n').length;
      const identity = `${location}:${label}:${fingerprint}`;
      if (fingerprints.has(identity)) continue;
      fingerprints.add(identity); findings.push({ location, line, detector: label, fingerprint });
    }
  }
}
const excluded = new Set(['.git', 'node_modules', '.humanizer', '.vercel']);
function walk(directory) {
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    if (excluded.has(entry.name) || entry.isSymbolicLink()) continue;
    const absolute = path.join(directory, entry.name);
    if (entry.isDirectory()) walk(absolute);
    else if (entry.isFile() && entry.name.endsWith('.asar')) scanArchive(absolute);
    else if (entry.isFile() && fs.statSync(absolute).size <= 8 * 1024 * 1024 && /(?:\.(?:js|cjs|mjs|html|css|json|ya?ml|md|txt|sh|ps1|env|pem|key|plist|toml)|^\.env(?:\..*)?)$/i.test(entry.name)) inspect(fs.readFileSync(absolute), path.relative(root, absolute));
  }
}
function scanArchive(archive) {
  for (const file of asar.listPackage(archive)) {
    const normalized = file.replaceAll('\\', '/').replace(/^\//, '');
    if (!/\.(?:js|cjs|mjs|html|json|env|pem|key)$/i.test(normalized) || normalized.startsWith('node_modules/')) continue;
    // ASAR lookups split on the host separator; keep slash-normalized paths
    // for filtering/reporting, but use native separators for archive access.
    const member = normalized.split('/').join(path.sep);
    const info = asar.statFile(archive, member);
    if (info.size > 8 * 1024 * 1024 || info.unpacked) continue;
    inspect(asar.extractFile(archive, member), `${path.relative(root, archive)}!/${normalized}`);
  }
}
walk(root);
if (process.argv.includes('--history')) {
  const objects = execFileSync('git', ['rev-list', '--objects', '--all'], { cwd: root, maxBuffer: 32 * 1024 * 1024 }).toString().trim().split('\n');
  const metadata = execFileSync('git', ['cat-file', '--batch-check=%(objectname) %(objecttype) %(objectsize)'], { cwd: root, input: objects.map(line => line.split(' ')[0]).join('\n') + '\n', maxBuffer: 32 * 1024 * 1024 }).toString().trim().split('\n');
  for (let index = 0; index < metadata.length; index++) {
    const [id, type, size] = metadata[index].split(' ');
    if (type !== 'blob' || Number(size) > 8 * 1024 * 1024) continue;
    const name = objects[index].slice(id.length + 1);
    if (!/\.(?:js|json|html|md|txt|sh|env|ya?ml|pem|key|toml|mjs|cjs|plist)$/i.test(name) && !/(?:^|\/)\.env/.test(name)) continue;
    inspect(execFileSync('git', ['cat-file', 'blob', id], { cwd: root, maxBuffer: 8 * 1024 * 1024 }), `git:${id.slice(0,12)}:${name}`);
  }
}
const external = process.argv.indexOf('--archive');
if (external >= 0) scanArchive(path.resolve(process.argv[external + 1]));
const result = { scanned, findings, scope: 'Project source, generated web/desktop files and ASARs; optional reachable Git history. Dependencies and local training environments excluded.' };
console.log(JSON.stringify(result, null, 2));
process.exitCode = findings.length ? 1 : 0;
