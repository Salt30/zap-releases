const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { build, publicFiles } = require('../website/build-static');
const config = require('../website/vercel.json');
const output = fs.mkdtempSync(path.join(os.tmpdir(), 'drip-static-audit-'));
build(output);
assert.equal(config.outputDirectory, 'public');
assert.equal(config.buildCommand, 'node build-static.js');
for (const forbidden of ['server', 'api', 'node_modules', '.env', 'package.json', 'build-static.js', 'vercel.json']) {
  assert.equal(fs.existsSync(path.join(output, forbidden)), false, `${forbidden} must not be public`);
}
let links = 0;
for (const file of publicFiles.filter((file) => /\.(html|css)$/.test(file))) {
  const source = fs.readFileSync(path.join(output, file), 'utf8');
  const references = [...source.matchAll(/(?:href|src)=["']([^"']+)["']|url\(["']?([^)'"\s]+)["']?\)/g)].map((match) => match[1] || match[2]);
  for (const reference of references) {
    const url = new URL(reference, `https://tryzap.net/${file}`);
    if (url.origin !== 'https://tryzap.net') continue;
    if (url.pathname.startsWith('/api/')) continue;
    const pathname = decodeURIComponent(url.pathname);
    let target = pathname === '/' ? 'index.html' : pathname.slice(1);
    if (!path.extname(target)) target += '.html';
    assert.ok(publicFiles.includes(target), `Missing public link ${reference} in ${file}`);
    if (url.hash && target.endsWith('.html')) {
      const targetHtml = fs.readFileSync(path.join(output, target), 'utf8');
      const ids = [...targetHtml.matchAll(/id=["']([^"']+)["']/g)].map((match) => match[1]);
      assert.ok(ids.includes(decodeURIComponent(url.hash.slice(1))), `Missing anchor ${reference} in ${file}`);
    }
    links++;
  }
}
console.log(`Website output passed: ${publicFiles.length} assets, ${links} internal references, backend source excluded.`);
