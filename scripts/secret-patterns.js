const crypto = require('node:crypto');
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
  ['assigned credential', /(?:AUTH_MASTER_KEY|ENTITLEMENT_PRIVATE_KEY|NVIDIA_API_KEY|STRIPE_SECRET_KEY|CRON_SECRET|SUPPORT_ENCRYPTION_KEY|SUPPORT_DATA_KEY|STRIPE_WEBHOOK_SECRET|BLOB_READ_WRITE_TOKEN|VERCEL_TOKEN|GH_TOKEN|GITHUB_TOKEN|API_KEY|apiKey|api_key|CLIENT_SECRET|SESSION_SECRET)["']?\s*[=:]\s*["']?([A-Za-z0-9_+/=-]{32,})/g],
];

// Return locations and fingerprints only; never return the credential itself.
function findSecrets(text, location) {
  const findings = [];
  for (const [label, pattern] of patterns) {
    pattern.lastIndex = 0;
    for (const match of text.matchAll(pattern)) {
      const token = match[1] || match[0];
      if (label !== 'private key' && new Set(token.replace(/^(?:nvapi-|sk_live_|sk_test_)/, '')).size < 8) continue;
      const fingerprint = crypto.createHash('sha256').update(token).digest('hex').slice(0, 12);
      // This exact nonfunctional OIDC-test placeholder also occurs in Git history.
      // Keep the exception scoped to its fingerprint and test file, never a directory.
      if (/(?:^|:)scripts\/verify-source\.js$/.test(location) && fingerprint === 'a1da3577d36b') continue;
      findings.push({
        location,
        line: text.slice(0, match.index).split('\n').length,
        detector: label,
        fingerprint,
      });
    }
  }
  return findings;
}
module.exports = { findSecrets };
