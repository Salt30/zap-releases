const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const read = file => fs.readFileSync(path.join(__dirname, '../website', file), 'utf8');
const html = read('index.html');
const data = JSON.parse(html.match(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/)[1]);
const app = data['@graph'].find(item => item['@type'] === 'SoftwareApplication');
assert.equal(app.name, 'Zap'); assert.equal(app.offers.price, '9.99');
assert.match(app.description, /Drip Type/); assert.match(app.description, /AI/);
assert.doesNotMatch(html, /Smart local templates|Pro Studio|Writing Lab|Batch personalization|data-checkout-plan="pro"/i);
const faq = data['@graph'].find(item => item['@type'] === 'FAQPage');
const section = html.slice(html.indexOf('class="faq-list"'), html.indexOf('class="closing-section"'));
const escape = value => value.replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;').replaceAll('"','&quot;').replaceAll("'",'&#x27;');
for (const item of faq.mainEntity) {
  assert(section.includes(escape(item.name)), `FAQ question missing from visible content: ${item.name}`);
  assert(section.includes(escape(item.acceptedAnswer.text)), `FAQ answer missing from visible content: ${item.name}`);
}
for (const page of ['index','support','legal','privacy','terms','refunds']) {
  const source = read(page+'.html');
  assert.equal((source.match(/<title>/g) || []).length,1);
  assert.equal((source.match(/rel="canonical"/g) || []).length,1);
  for (const name of ['og:title','og:description','og:image','twitter:card']) assert(source.includes(`="${name}"`), `${page} missing ${name}`);
}
for (const page of ['account','admin','success']) assert.match(read(page+'.html'), /name="robots" content="noindex,nofollow,noarchive"/);
assert.doesNotMatch(read('sitemap.xml'), /\/(?:account|admin|success|api)[<\/]/);
assert.match(read('sitemap.xml'), /2026-09-15/);
console.log('SEO/AEO passed: visible FAQ matches structured answers, current product claims, Core pricing, canonical/social tags, private-page noindex.');
