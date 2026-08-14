const { createHash, createPublicKey, verify } = require('node:crypto');

const ENTITLEMENT_PUBLIC_KEY = 'MCowBQYDK2VwAyEAmvSBJU6YWUoxNHTzpdDgutQdvceW9PBHNupa/JaManE=';
const ENTITLEMENT_ISSUER = 'https://tryzap.net';
const ENTITLEMENT_AUDIENCE = 'com.salt30.driptype';
const TRIAL_LENGTH_MS = 14 * 24 * 60 * 60 * 1000;
const KNOWN_FEATURES = new Set([
  'composer', 'typing', 'hotkeys', 'templates', 'updates', 'profiles', 'clipboard'
]);
const AUTHORITATIVE_REJECTION_STATUSES = new Set([401, 402, 403]);

function shouldRevokeEntitlement(status) {
  return AUTHORITATIVE_REJECTION_STATUSES.has(Number(status));
}

function deviceHash(deviceId) {
  return createHash('sha256').update(String(deviceId)).digest('base64url').slice(0, 40);
}

function decodeJson(segment) {
  return JSON.parse(Buffer.from(segment, 'base64url').toString('utf8'));
}

function verifyEntitlement(token, deviceId, now = Date.now(), encodedPublicKey = ENTITLEMENT_PUBLIC_KEY) {
  if (typeof token !== 'string' || token.length > 8192) throw new Error('Invalid entitlement token');
  const parts = token.split('.');
  if (parts.length !== 3) throw new Error('Invalid entitlement token');
  const [headerSegment, payloadSegment, signatureSegment] = parts;
  const header = decodeJson(headerSegment);
  const payload = decodeJson(payloadSegment);
  if (header.alg !== 'EdDSA' || header.kid !== 'drip-type-v1' || header.typ !== 'JWT') {
    throw new Error('Unsupported entitlement signature');
  }
  const publicKey = createPublicKey({
    key: Buffer.from(encodedPublicKey, 'base64'),
    format: 'der',
    type: 'spki'
  });
  const valid = verify(
    null,
    Buffer.from(`${headerSegment}.${payloadSegment}`),
    publicKey,
    Buffer.from(signatureSegment, 'base64url')
  );
  if (!valid) throw new Error('Invalid entitlement signature');
  const nowSeconds = Math.floor(now / 1000);
  if (
    payload.v !== 1 ||
    payload.iss !== ENTITLEMENT_ISSUER ||
    payload.aud !== ENTITLEMENT_AUDIENCE ||
    !['core', 'pro'].includes(payload.plan) ||
    payload.device !== deviceHash(deviceId) ||
    !Number.isInteger(payload.iat) ||
    !Number.isInteger(payload.exp) ||
    payload.iat > nowSeconds + 300 ||
    payload.exp <= nowSeconds ||
    payload.exp - payload.iat > 4 * 24 * 60 * 60 ||
    !Array.isArray(payload.features) ||
    payload.features.some((feature) => !KNOWN_FEATURES.has(feature))
  ) {
    throw new Error('Entitlement claims were rejected');
  }
  return Object.freeze({ ...payload, features: Object.freeze([...new Set(payload.features)]) });
}

function accessState({ token, deviceId, trialStartedAt, now = Date.now() }) {
  try {
    const entitlement = verifyEntitlement(token, deviceId, now);
    return {
      allowed: entitlement.features.includes('composer'),
      status: 'active',
      plan: entitlement.plan,
      features: entitlement.features,
      expiresAt: new Date(entitlement.exp * 1000).toISOString(),
      message: `${entitlement.plan === 'pro' ? 'Pro' : 'Core'} subscription active.`
    };
  } catch (_) {
    const start = Number(trialStartedAt);
    const trialEndsAt = Number.isFinite(start) ? start + TRIAL_LENGTH_MS : 0;
    if (trialEndsAt > now) {
      const daysRemaining = Math.max(1, Math.ceil((trialEndsAt - now) / (24 * 60 * 60 * 1000)));
      return {
        allowed: true,
        status: 'trial',
        plan: 'core',
        features: ['composer', 'typing', 'hotkeys', 'templates', 'updates'],
        trialEndsAt: new Date(trialEndsAt).toISOString(),
        daysRemaining,
        message: `${daysRemaining}-day Core trial active.`
      };
    }
    return {
      allowed: false,
      status: 'required',
      plan: null,
      features: ['updates'],
      message: 'Choose Core to keep using Drip Composer.'
    };
  }
}

module.exports = {
  ENTITLEMENT_PUBLIC_KEY,
  TRIAL_LENGTH_MS,
  accessState,
  deviceHash,
  shouldRevokeEntitlement,
  verifyEntitlement
};
