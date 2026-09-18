const { randomBytes, createHash } = require('node:crypto');

// Passwords stay in the system browser. Only device-bound credentials enter
// the main process; epochs prevent late network replies from undoing sign-out.
function createAccountSession({ store, deviceId, readCredential, saveCredential, deleteCredential, request, validateEntitlement, publish, openBrowser, onSignOut, now = Date.now }) {
  let epoch = 0;
  let pending = null;
  let signingOut = null;
  let writes = Promise.resolve();
  const exclusive = (fn) => { const result = writes.then(fn); writes = result.catch(() => {}); return result; };
  const signedOut = () => store.get('accountSignedOut', false);
  function accept(result) {
    validateEntitlement(result.entitlement, deviceId());
    store.set('entitlementToken', result.entitlement);
    store.set('accountConnected', true);
    return publish();
  }
  async function credentials() {
    const revision = epoch;
    if (signedOut() || signingOut) return { deviceId: deviceId(), refreshToken: '' };
    const refreshToken = await readCredential();
    return { deviceId: deviceId(), refreshToken: revision === epoch && !signedOut() ? refreshToken : '' };
  }
  async function beginSignIn() {
    if (signingOut) throw new Error('Wait for sign-out to finish.');
    const attempt = { state: randomBytes(32).toString('base64url'), verifier: randomBytes(32).toString('base64url'), expires: now() + 10 * 60000, revision: ++epoch };
    pending = attempt;
    try {
      await openBrowser(`https://tryzap.net/account?mode=signin&connect_device=${encodeURIComponent(deviceId())}&connect_state=${attempt.state}&connect_challenge=${createHash('sha256').update(attempt.verifier).digest('base64url')}`);
    } catch {
      if (pending === attempt) pending = null;
      throw new Error('Your browser could not be opened. Try signing in again.');
    }
    return publish({ message: 'Sign in at tryzap.net in your browser, then choose Connect app.' });
  }
  async function activate(activationToken) {
    if (typeof activationToken !== 'string' || activationToken.length > 2048 || !/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(activationToken)) throw new Error('Invalid account connection link.');
    let payload;
    try { payload = JSON.parse(Buffer.from(activationToken.split('.')[1], 'base64url').toString('utf8')); } catch { throw new Error('Invalid account connection link.'); }
    const attempt = pending;
    if (!attempt || attempt.expires <= now() || payload.state !== attempt.state || attempt.revision !== epoch || signingOut) throw new Error('Start Sign in in Zap to create a new secure connection.');
    pending = null;
    const result = await request('/api/claim-account-entitlement', { activationToken, deviceId: deviceId(), codeVerifier: attempt.verifier });
    return exclusive(async () => {
      if (attempt.revision !== epoch) return publish();
      validateEntitlement(result.entitlement, deviceId());
      await saveCredential(result.refreshToken);
      if (attempt.revision !== epoch) { await deleteCredential(); return publish(); }
      store.set('accountSignedOut', false);
      store.set('accountCleanupPending', false);
      return accept(result);
    });
  }
  async function refresh() {
    const revision = epoch;
    const credential = await credentials();
    if (!credential.refreshToken) return publish();
    try {
      const result = await request('/api/refresh-entitlement', credential);
      if (revision !== epoch || signedOut()) return publish();
      return accept(result);
    } catch (error) {
      if (revision !== epoch || signedOut()) return publish();
      throw error;
    }
  }
  function signOut() {
    if (signingOut) return signingOut;
    const existing = readCredential().catch(() => '');
    ++epoch; pending = null;
    store.set('accountSignedOut', true);
    store.set('accountConnected', false);
    store.set('entitlementToken', '');
    onSignOut();
    publish({ message: 'Signed out of Zap on this device.' });
    signingOut = exclusive(async () => {
      const credential = await existing;
      let warning = '';
      try { await deleteCredential(); store.set('accountCleanupPending', false); }
      catch { store.set('accountCleanupPending', true); warning = 'Signed out, but secure storage cleanup failed. Try Sign out again.'; }
      if (credential) {
        try { await request('/api/disconnect-device', { refreshToken: credential, deviceId: deviceId() }); }
        catch { warning ||= 'Signed out on this device. The server could not confirm credential revocation; reconnect when online to replace the old credential.'; }
      }
      return { ...publish({ message: warning || 'Signed out of Zap on this device.' }), warning };
    }).finally(() => { signingOut = null; });
    return signingOut;
  }
  return { credentials, beginSignIn, activate, refresh, signOut, revision: () => epoch };
}
module.exports = { createAccountSession };
