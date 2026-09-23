const { BlobPreconditionFailedError, get, head, list, put } = require("@vercel/blob");
const {
  createCipheriv,
  createDecipheriv,
  createHmac,
  hkdfSync,
  randomBytes,
  scrypt: scryptCallback,
  timingSafeEqual,
} = require("node:crypto");
const { promisify } = require("node:util");

const scrypt = promisify(scryptCallback);
const PREFIX = "zap-accounts/";
const COOKIE_NAME = "__Host-zap_session";
const ACCOUNT_VERSION = 1;
const SESSION_TTL_SECONDS = 7 * 24 * 60 * 60;
const PASSWORD_MIN_LENGTH = 12;
const PASSWORD_MAX_LENGTH = 128;
const MAX_RECORD_BYTES = 24_000;
const MAX_LOGIN_FAILURES = 5;
const LOCKOUT_MS = 15 * 60 * 1000;
const SCRYPT_OPTIONS = Object.freeze({ N: 32768, r: 8, p: 1, maxmem: 64 * 1024 * 1024 });

function masterKey() {
  const encoded = String(process.env.AUTH_MASTER_KEY || "").trim();
  if (!/^[A-Za-z0-9_-]{43}$/u.test(encoded)) return null;
  try {
    const key = Buffer.from(encoded, "base64url");
    return key.length === 32 ? key : null;
  } catch {
    return null;
  }
}

function deriveKey(label) {
  const key = masterKey();
  if (!key) throw new Error("account_encryption_not_configured");
  return Buffer.from(hkdfSync("sha256", key, Buffer.alloc(0), Buffer.from(`drip-type:${label}`), 32));
}

function storageConfigured() {
  const token = String(process.env.BLOB_READ_WRITE_TOKEN || "");
  const blobConfigured = (token.length >= 32 && token.length <= 4096) ||
    /^store_[A-Za-z0-9]+$/u.test(String(process.env.BLOB_STORE_ID || ""));
  return blobConfigured && Boolean(masterKey());
}

function normalizeEmail(value) {
  if (typeof value !== "string") throw new Error("invalid_email");
  const email = String(value || "").trim().toLowerCase();
  if (
    email.length < 6 || email.length > 254 ||
    !/^[a-z0-9.!#$%&'*+/=?^_`{|}~-]{1,64}@[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/u.test(email)
  ) throw new Error("invalid_email");
  return email;
}

function validAccountId(value) {
  return typeof value === "string" && /^acct_[A-Za-z0-9_-]{32}$/u.test(value);
}

function validCheckoutUrl(value) {
  if (value === null) return true;
  if (typeof value !== "string" || value.length > 2048) return false;
  try {
    const url = new URL(value);
    return url.protocol === "https:" && url.hostname === "checkout.stripe.com" &&
      !url.username && !url.password;
  } catch {
    return false;
  }
}

function accountIdForEmail(email) {
  return `acct_${createHmac("sha256", deriveKey("account-index"))
    .update(normalizeEmail(email))
    .digest("base64url")
    .slice(0, 32)}`;
}

function pathname(accountId) {
  if (!validAccountId(accountId)) throw new Error("invalid_account_id");
  return `${PREFIX}${accountId}.json`;
}

function passwordScore(value) {
  const password = String(value || "");
  if (password.length < PASSWORD_MIN_LENGTH) return 0;
  if (/^(password|qwerty|123456|letmein|abcdef|driptype|tryzap)/iu.test(password) || /(.)\1{4}/u.test(password)) {
    return 0;
  }
  let score = 1;
  const characterGroups = [/[a-z]/u, /[A-Z]/u, /\d/u, /[^A-Za-z0-9]/u]
    .filter((pattern) => pattern.test(password)).length;
  if (password.length >= 8) score += 1;
  if (characterGroups >= 2) score += 1;
  if (password.length >= 12 || characterGroups >= 3) score += 1;
  return Math.min(4, score);
}

function validatePassword(password, email = "") {
  if (
    typeof password !== "string" || password.length < PASSWORD_MIN_LENGTH ||
    password.length > PASSWORD_MAX_LENGTH || Buffer.byteLength(password, "utf8") > 256 ||
    /[\u0000-\u001f\u007f]/u.test(password) || passwordScore(password) < 2 ||
    (email && password.toLowerCase().includes(String(email).split("@")[0].toLowerCase()))
  ) throw new Error("weak_password");
  return password;
}

async function passwordRecord(password) {
  const salt = randomBytes(16);
  const hash = await scrypt(password, salt, 32, SCRYPT_OPTIONS);
  return {
    algorithm: "scrypt",
    salt: salt.toString("base64url"),
    hash: Buffer.from(hash).toString("base64url"),
    N: SCRYPT_OPTIONS.N,
    r: SCRYPT_OPTIONS.r,
    p: SCRYPT_OPTIONS.p,
  };
}

async function verifyPassword(password, record) {
  const salt = /^[A-Za-z0-9_-]{22}$/u.test(String(record?.salt || ""))
    ? Buffer.from(record.salt, "base64url")
    : Buffer.alloc(16);
  const expected = /^[A-Za-z0-9_-]{43}$/u.test(String(record?.hash || ""))
    ? Buffer.from(record.hash, "base64url")
    : Buffer.alloc(32);
  const actual = Buffer.from(await scrypt(String(password || ""), salt, 32, SCRYPT_OPTIONS));
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}

function recoveryCode() {
  return `ZAP-${randomBytes(24).toString("base64url")}`;
}

function recoveryHash(code) {
  return createHmac("sha256", deriveKey("account-recovery"))
    .update(String(code || ""))
    .digest("base64url");
}

function encodeAccount(account) {
  const plaintext = Buffer.from(JSON.stringify(account), "utf8");
  if (plaintext.byteLength > MAX_RECORD_BYTES) throw new Error("account_record_too_large");
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", deriveKey("account-encryption"), iv);
  cipher.setAAD(Buffer.from(pathname(account.accountId), "utf8"));
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  return JSON.stringify({
    version: 1,
    algorithm: "A256GCM",
    iv: iv.toString("base64url"),
    tag: cipher.getAuthTag().toString("base64url"),
    ciphertext: ciphertext.toString("base64url"),
  });
}

function validateAccount(account, expectedId) {
  if (
    !account || typeof account !== "object" || Array.isArray(account) ||
    account.version !== ACCOUNT_VERSION || account.accountId !== expectedId ||
    !validAccountId(account.accountId) || normalizeEmail(account.email) !== account.email ||
    !Number.isSafeInteger(account.sessionVersion) || account.sessionVersion < 1 ||
    !Number.isSafeInteger(account.failedAttempts) || account.failedAttempts < 0 || account.failedAttempts > 100 ||
    (account.lockUntil !== null && !Number.isSafeInteger(account.lockUntil)) ||
    typeof account.recoveryHash !== "string" || !/^[A-Za-z0-9_-]{43}$/u.test(account.recoveryHash)
  ) throw new Error("invalid_account_record");
  if (account.revokedSessions !== undefined && (!Array.isArray(account.revokedSessions) || account.revokedSessions.length > 64 ||
      account.revokedSessions.some(item => !item || !/^[A-Za-z0-9_-]{22}$/.test(item.nonce) || !Number.isSafeInteger(item.exp)))) throw new Error('invalid_account_record');
  return account;
}

function decodeAccount(value, expectedId) {
  const envelope = JSON.parse(value);
  if (
    envelope?.version !== 1 || envelope?.algorithm !== "A256GCM" ||
    !/^[A-Za-z0-9_-]{16}$/u.test(String(envelope.iv || "")) ||
    !/^[A-Za-z0-9_-]{22}$/u.test(String(envelope.tag || "")) ||
    typeof envelope.ciphertext !== "string" || envelope.ciphertext.length > MAX_RECORD_BYTES * 2
  ) throw new Error("invalid_encrypted_account");
  try {
    const decipher = createDecipheriv(
      "aes-256-gcm",
      deriveKey("account-encryption"),
      Buffer.from(envelope.iv, "base64url"),
    );
    decipher.setAAD(Buffer.from(pathname(expectedId), "utf8"));
    decipher.setAuthTag(Buffer.from(envelope.tag, "base64url"));
    const plaintext = Buffer.concat([
      decipher.update(Buffer.from(envelope.ciphertext, "base64url")),
      decipher.final(),
    ]);
    if (plaintext.byteLength > MAX_RECORD_BYTES) throw new Error("account_record_too_large");
    return validateAccount(JSON.parse(plaintext.toString("utf8")), expectedId);
  } catch (error) {
    if (error.message === "account_record_too_large" || error.message === "invalid_account_record") throw error;
    throw new Error("account_decryption_failed");
  }
}

async function streamText(stream) {
  if (!stream) throw new Error("account_not_found");
  const reader = stream.getReader();
  const chunks = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_RECORD_BYTES * 2) throw new Error("account_record_too_large");
      chunks.push(Buffer.from(value));
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks).toString("utf8");
}

async function readAccountById(accountId) {
  if (!storageConfigured() || !validAccountId(accountId)) return null;
  const result = await get(pathname(accountId), { access: "private", useCache: false });
  if (!result || result.statusCode !== 200) return null;
  return { account: decodeAccount(await streamText(result.stream), accountId), etag: result.blob.etag };
}

async function readAccountByEmail(email) {
  return readAccountById(accountIdForEmail(email));
}

async function accountById(accountId) {
  const existing = await readAccountById(accountId);
  return existing?.account || null;
}

async function listAccountBlobs() {
  if (!storageConfigured()) throw new Error("account_storage_not_configured");
  const blobs = [];
  let cursor;
  const seenCursors = new Set();
  do {
    const result = await list({ prefix: PREFIX, limit: 1000, ...(cursor ? { cursor } : {}) });
    blobs.push(...(Array.isArray(result?.blobs) ? result.blobs : []).filter((blob) => (
      /^zap-accounts\/acct_[A-Za-z0-9_-]{32}\.json$/u.test(String(blob?.pathname || "")) &&
      Number(blob?.size || 0) <= MAX_RECORD_BYTES * 2
    )));
    if (blobs.length > 25_000) throw new Error("account_list_too_large");
    cursor = result?.hasMore ? String(result.cursor || "") : "";
    if (cursor && seenCursors.has(cursor)) throw new Error("account_list_cursor_loop");
    if (cursor) seenCursors.add(cursor);
  } while (cursor);
  return blobs;
}

async function mapWithConcurrency(values, limit, mapper) {
  const output = new Array(values.length);
  let nextIndex = 0;
  async function worker() {
    while (nextIndex < values.length) {
      const index = nextIndex;
      nextIndex += 1;
      output[index] = await mapper(values[index], index);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, values.length) }, worker));
  return output;
}

async function listAccountSummaries() {
  const blobs = await listAccountBlobs();
  let unreadableCount = 0;
  const accounts = (await mapWithConcurrency(blobs, 8, async (blob) => {
    const match = /^zap-accounts\/(acct_[A-Za-z0-9_-]{32})\.json$/u.exec(String(blob?.pathname || ""));
    if (!match) return null;
    try {
      const existing = await readAccountById(match[1]);
      if (!existing) return null;
      const account = existing.account;
      return {
        accountId: account.accountId,
        email: account.email,
        createdAt: account.createdAt || null,
        updatedAt: account.updatedAt || null,
        lastLoginAt: account.lastLoginAt || null,
        stripeCustomerId: account.stripeCustomerId || null,
        stripeSubscriptionId: account.stripeSubscriptionId || null,
        stripeSubscriptionStatus: account.stripeSubscriptionStatus || null,
        stripeSubscriptionPlan: account.stripeSubscriptionPlan || null,
      };
    } catch {
      unreadableCount += 1;
      return null;
    }
  })).filter(Boolean);
  return { accounts, total: blobs.length, unreadableCount };
}

async function writeAccount(account, options = {}) {
  return put(pathname(account.accountId), encodeAccount(account), {
    access: "private",
    addRandomSuffix: false,
    allowOverwrite: options.create ? false : true,
    ...(options.etag ? { ifMatch: options.etag } : {}),
    cacheControlMaxAge: 60,
    contentType: "application/json; charset=utf-8",
  });
}

async function mutateAccount(accountId, mutator) {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const existing = await readAccountById(accountId);
    if (!existing) throw new Error("account_not_found");
    const metadata = await head(pathname(accountId), { access: "private" });
    const contentEtag = String(existing.etag || "").replace(/^W\//u, "");
    const metadataEtag = String(metadata?.etag || "").replace(/^W\//u, "");
    if (!contentEtag || !metadataEtag || contentEtag !== metadataEtag) continue;
    const updated = await mutator(structuredClone(existing.account));
    updated.updatedAt = new Date().toISOString();
    try {
      await writeAccount(validateAccount(updated, accountId), { etag: metadata.etag });
      return updated;
    } catch (error) {
      const preconditionFailed = error instanceof BlobPreconditionFailedError ||
        /Precondition failed: ETag mismatch\.?/u.test(String(error?.message || ""));
      if (!preconditionFailed || attempt === 2) throw error;
    }
  }
  throw new Error("account_update_conflict");
}

async function createAccount(emailValue, passwordValue) {
  if (!storageConfigured()) throw new Error("account_storage_not_configured");
  const email = normalizeEmail(emailValue);
  const password = validatePassword(passwordValue, email);
  const accountId = accountIdForEmail(email);
  const createdAt = new Date().toISOString();
  const newRecoveryCode = recoveryCode();
  const account = {
    version: ACCOUNT_VERSION,
    accountId,
    email,
    password: await passwordRecord(password),
    recoveryHash: recoveryHash(newRecoveryCode),
    sessionVersion: 1,
    failedAttempts: 0,
    lockUntil: null,
    stripeCustomerId: null,
    stripeSubscriptionId: null,
    stripeSubscriptionStatus: null,
    stripeSubscriptionPlan: null,
    stripeEventCreated: 0,
    stripeEventId: null,
    stripeCheckoutUrl: null,
    stripeCheckoutPlan: null,
    stripeCheckoutExpiresAt: null,
    createdAt,
    updatedAt: createdAt,
    lastLoginAt: createdAt,
  };
  try {
    await writeAccount(account, { create: true });
  } catch (error) {
    if (error?.name === "BlobPreconditionFailedError") throw new Error("account_exists");
    throw error;
  }
  return { account, recoveryCode: newRecoveryCode };
}

async function dummyPasswordCheck(password) {
  const salt = createHmac("sha256", deriveKey("dummy-password"))
    .update("missing-account")
    .digest()
    .subarray(0, 16);
  await scrypt(String(password || ""), salt, 32, SCRYPT_OPTIONS);
}

async function authenticate(emailValue, password) {
  if (typeof password !== "string" || !password || password.length > PASSWORD_MAX_LENGTH || Buffer.byteLength(password, "utf8") > 256) throw new Error("invalid_credentials");
  if (!storageConfigured()) throw new Error("account_storage_not_configured");
  let email;
  try {
    email = normalizeEmail(emailValue);
  } catch {
    await dummyPasswordCheck(password);
    throw new Error("invalid_credentials");
  }
  const existing = await readAccountByEmail(email);
  if (!existing) {
    await dummyPasswordCheck(password);
    throw new Error("invalid_credentials");
  }
  const now = Date.now();
  if (existing.account.lockUntil && existing.account.lockUntil > now) {
    await dummyPasswordCheck(password);
    throw new Error("account_locked");
  }
  const valid = await verifyPassword(password, existing.account.password);
  if (!valid) {
    await mutateAccount(existing.account.accountId, (account) => {
      account.failedAttempts = Math.min(100, account.failedAttempts + 1);
      account.lockUntil = account.failedAttempts >= MAX_LOGIN_FAILURES ? Date.now() + LOCKOUT_MS : null;
      return account;
    });
    throw new Error("invalid_credentials");
  }
  return mutateAccount(existing.account.accountId, (account) => {
    // Revalidate the snapshot under the conditional write: a concurrent password
    // reset must invalidate an authentication still using the previous password.
    if (account.sessionVersion !== existing.account.sessionVersion ||
        account.password.hash !== existing.account.password.hash ||
        account.password.salt !== existing.account.password.salt) throw new Error('invalid_credentials');
    account.failedAttempts = 0;
    account.lockUntil = null;
    account.lastLoginAt = new Date().toISOString();
    return account;
  });
}

async function resetPassword(emailValue, code, passwordValue) {
  if (!storageConfigured()) throw new Error("account_storage_not_configured");
  const email = normalizeEmail(emailValue);
  const password = validatePassword(passwordValue, email);
  const existing = await readAccountByEmail(email);
  if (!existing) {
    await dummyPasswordCheck(password);
    throw new Error("invalid_recovery");
  }
  const supplied = recoveryHash(code);
  const expected = existing.account.recoveryHash;
  if (!/^[A-Za-z0-9_-]{43}$/u.test(supplied) || !timingSafeEqual(Buffer.from(supplied), Buffer.from(expected))) {
    await dummyPasswordCheck(password);
    throw new Error("invalid_recovery");
  }
  const newRecoveryCode = recoveryCode();
  const replacement = await passwordRecord(password);
  const account = await mutateAccount(existing.account.accountId, (current) => {
    // Recovery codes are single-use even when two requests verify in parallel.
    if (current.recoveryHash !== expected) throw new Error('invalid_recovery');
    current.password = replacement;
    current.recoveryHash = recoveryHash(newRecoveryCode);
    current.sessionVersion += 1;
    current.failedAttempts = 0;
    current.lockUntil = null;
    current.lastLoginAt = new Date().toISOString();
    return current;
  });
  return { account, recoveryCode: newRecoveryCode };
}

function sessionToken(account, now = Math.floor(Date.now() / 1000)) {
  const payload = Buffer.from(JSON.stringify({
    v: 1,
    sub: account.accountId,
    sv: account.sessionVersion,
    iat: now,
    exp: now + SESSION_TTL_SECONDS,
    nonce: randomBytes(16).toString("base64url"),
  })).toString("base64url");
  const signature = createHmac("sha256", deriveKey("session-signing"))
    .update(`v1.${payload}`)
    .digest("base64url");
  return `v1.${payload}.${signature}`;
}

function parseSessionToken(token, now = Math.floor(Date.now() / 1000)) {
  if (typeof token !== "string" || token.length > 1024) return null;
  const parts = token.split(".");
  if (parts.length !== 3 || parts[0] !== "v1" || parts.slice(1).some((part) => !/^[A-Za-z0-9_-]+$/u.test(part))) {
    return null;
  }
  const expected = createHmac("sha256", deriveKey("session-signing"))
    .update(`v1.${parts[1]}`)
    .digest("base64url");
  if (expected.length !== parts[2].length || !timingSafeEqual(Buffer.from(expected), Buffer.from(parts[2]))) return null;
  let payload;
  try {
    payload = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8"));
  } catch {
    return null;
  }
  if (
    payload?.v !== 1 || !validAccountId(payload.sub) || !Number.isSafeInteger(payload.sv) || payload.sv < 1 ||
    !Number.isSafeInteger(payload.iat) || !Number.isSafeInteger(payload.exp) || payload.iat > now + 30 ||
    payload.exp <= now || payload.exp - payload.iat !== SESSION_TTL_SECONDS ||
    !/^[A-Za-z0-9_-]{22}$/u.test(String(payload.nonce || ""))
  ) return null;
  return payload;
}

function requestCookie(request) {
  const header = String(request.headers?.cookie || "");
  if (header.length > 4096) return "";
  for (const item of header.split(";")) {
    const separator = item.indexOf("=");
    if (separator < 0) continue;
    if (item.slice(0, separator).trim() === COOKIE_NAME) return item.slice(separator + 1).trim();
  }
  return "";
}

function setSessionCookie(response, account) {
  response.setHeader("Set-Cookie", [
    `${COOKIE_NAME}=${sessionToken(account)}`,
    "Path=/",
    `Max-Age=${SESSION_TTL_SECONDS}`,
    "HttpOnly",
    "Secure",
    "SameSite=Lax",
    "Priority=High",
  ].join("; "));
}

function clearSessionCookie(response) {
  response.setHeader("Set-Cookie", `${COOKIE_NAME}=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Lax; Priority=High`);
}

async function accountForRequest(request) {
  if (!storageConfigured()) return null;
  const payload = parseSessionToken(requestCookie(request));
  if (!payload) return null;
  const existing = await readAccountById(payload.sub);
  if (!existing || existing.account.sessionVersion !== payload.sv) return null;
  if ((existing.account.revokedSessions || []).some(item => item.nonce === payload.nonce)) return null;
  return existing.account;
}

async function revokeSession(request) {
  if (!storageConfigured()) throw new Error('account_storage_unavailable');
  const payload = parseSessionToken(requestCookie(request));
  if (!payload) return;
  const existing = await readAccountById(payload.sub);
  if (!existing || existing.account.sessionVersion !== payload.sv) return;
  await mutateAccount(payload.sub, (account) => {
    if (account.sessionVersion !== payload.sv) return account;
    const now = Math.floor(Date.now() / 1000);
    const revoked = (account.revokedSessions || []).filter(item => item.exp > now);
    if (!revoked.some(item => item.nonce === payload.nonce)) revoked.push({ nonce: payload.nonce, exp: payload.exp });
    // Bound the record without ever making a revoked cookie valid again.
    if (revoked.length > 64) { account.sessionVersion++; account.revokedSessions = []; }
    else account.revokedSessions = revoked;
    return account;
  });
}

async function updateBillingMetadata(accountId, values) {
  const allowed = {
    stripeCustomerId: (value) => value === null || /^cus_[A-Za-z0-9]+$/u.test(String(value)),
    stripeSubscriptionId: (value) => value === null || /^sub_[A-Za-z0-9]+$/u.test(String(value)),
    stripeSubscriptionStatus: (value) => value === null || /^[a-z_]{1,40}$/u.test(String(value)),
    stripeSubscriptionPlan: (value) => value === null || ["core", "pro"].includes(value),
    stripeEventCreated: (value) => Number.isSafeInteger(value) && value >= 0,
    stripeEventId: (value) => value === null || /^evt_[A-Za-z0-9]+$/u.test(String(value)),
    stripeCheckoutUrl: validCheckoutUrl,
    stripeCheckoutPlan: (value) => value === null || ["core", "pro"].includes(value),
    stripeCheckoutExpiresAt: (value) => value === null || (Number.isSafeInteger(value) && value >= 0),
  };
  if (!values || typeof values !== "object" || Array.isArray(values)) throw new Error("invalid_billing_metadata");
  for (const [key, value] of Object.entries(values)) {
    if (!Object.hasOwn(allowed, key) || !allowed[key](value)) throw new Error("invalid_billing_metadata");
  }
  return mutateAccount(accountId, (account) => Object.assign(account, values));
}

module.exports = {
  COOKIE_NAME,
  PASSWORD_MAX_LENGTH,
  PASSWORD_MIN_LENGTH,
  accountById,
  accountForRequest,
  accountIdForEmail,
  authenticate,
  clearSessionCookie,
  createAccount,
  decodeAccount,
  encodeAccount,
  listAccountSummaries,
  normalizeEmail,
  parseSessionToken,
  passwordScore,
  resetPassword,
  revokeSession,
  setSessionCookie,
  sessionToken,
  storageConfigured,
  updateBillingMetadata,
  validAccountId,
  validatePassword,
};
