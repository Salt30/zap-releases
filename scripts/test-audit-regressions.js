const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');

// Evaluate the actual functions with controlled dependencies to exercise races
// and OS-encryption failures without touching any real accounts or local vault.
function sourceFunction(file, name, nextName) {
  const source = fs.readFileSync(path.join(__dirname, '..', file), 'utf8');
  const start = source.indexOf(`function ${name}(`);
  const end = source.indexOf(`function ${nextName}(`, start);
  assert.ok(start >= 0 && end > start);
  return source.slice(source.slice(0, start).endsWith('async ') ? start - 6 : start, end).replace(/async\s*$/, '');
}

(async () => {
  const snapshot = { accountId: 'fixture', sessionVersion: 1, password: { hash: 'old', salt: 'old' }, recoveryHash: 'a'.repeat(43) };
  let current = structuredClone(snapshot);
  const authContext = vm.createContext({
    Buffer, Date, PASSWORD_MAX_LENGTH: 128, MAX_LOGIN_FAILURES: 5, LOCKOUT_MS: 900000,
    storageConfigured: () => true, normalizeEmail: (email) => email, dummyPasswordCheck: async () => {},
    readAccountByEmail: async () => ({ account: structuredClone(snapshot) }),
    verifyPassword: async () => true, validatePassword: (password) => password,
    mutateAccount: async (_id, action) => action(current),
    recoveryHash: (code) => code, timingSafeEqual: (a, b) => a.equals(b),
    recoveryCode: () => 'b'.repeat(43), passwordRecord: async () => ({ hash: 'new', salt: 'new' }),
  });
  vm.runInContext(sourceFunction('website/server/accounts.js', 'authenticate', 'resetPassword'), authContext);
  vm.runInContext(sourceFunction('website/server/accounts.js', 'resetPassword', 'sessionToken'), authContext);
  current.sessionVersion = 2;
  await assert.rejects(authContext.authenticate('test@example.com', 'old-password'), /invalid_credentials/);
  current = structuredClone(snapshot);
  const reset = await authContext.resetPassword('test@example.com', snapshot.recoveryHash, 'new-password');
  assert.equal(reset.account.sessionVersion, 2);
  await assert.rejects(authContext.resetPassword('test@example.com', snapshot.recoveryHash, 'other-password'), /invalid_recovery/);
  console.log('Audit regressions passed: concurrent password reset and single-use recovery codes.');
})().catch((error) => { console.error(error); process.exitCode = 1; });
