const billing = require('./_billing');
const ticketStore = require("../server/tickets");
const MAX_BODY_BYTES = 12_000;

const CATEGORIES = Object.freeze({
  bug: "Bug or broken feature",
  crash: "Crash or startup problem",
  billing: "Billing or subscription",
  activation: "Activation or update",
  request: "Feature request",
  other: "Something else",
});

const PLATFORMS = Object.freeze({
  windows: "Windows",
  macos: "macOS",
  website: "Website",
  billing: "Billing or activation",
  other: "Other",
});

function setHeaders(response) {
  response.setHeader("Cache-Control", "no-store");
  response.setHeader("Content-Type", "application/json; charset=utf-8");
  response.setHeader("X-Content-Type-Options", "nosniff");
}

function isPlainObject(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function hasExactKeys(value, expectedKeys) {
  if (!isPlainObject(value)) return false;
  const actual = Object.keys(value);
  return actual.length === expectedKeys.length &&
    expectedKeys.every((key) => Object.prototype.hasOwnProperty.call(value, key));
}

function configuredOrigin() {
  const configured = process.env.PUBLIC_SITE_URL || "";
  const url = new URL(configured);
  if (
    url.protocol !== "https:" ||
    !["tryzap.net", "www.tryzap.net", "drip-type.vercel.app"].includes(url.hostname) ||
    url.username || url.password || url.pathname !== "/"
  ) {
    throw new Error("PUBLIC_SITE_URL is not an approved HTTPS origin");
  }
  return url.origin;
}

function parseBody(request) {
  let body = request.body;
  if (typeof body === "string") {
    if (Buffer.byteLength(body, "utf8") > MAX_BODY_BYTES) throw new Error("too_large");
    body = JSON.parse(body);
  }
  if (!isPlainObject(body)) throw new Error("invalid_body");
  if (Buffer.byteLength(JSON.stringify(body), "utf8") > MAX_BODY_BYTES) throw new Error("too_large");
  return body;
}

function singleLine(value, maximum) {
  if (typeof value !== "string" || /[\u0000-\u001f\u007f]/u.test(value)) return null;
  const normalized = value.trim().replace(/\s+/gu, " ");
  if (!normalized || normalized.length > maximum) return null;
  return normalized;
}

function optionalSingleLine(value, maximum) {
  if (typeof value !== "string" || /[\u0000-\u001f\u007f]/u.test(value)) return null;
  const normalized = value.trim().replace(/\s+/gu, " ");
  return normalized.length <= maximum ? normalized : null;
}

function issueDescription(value) {
  if (typeof value !== "string") return null;
  const normalized = value.replace(/\r\n?/gu, "\n").trim();
  if (
    normalized.length < 20 || normalized.length > 5000 ||
    /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(normalized)
  ) return null;
  return normalized;
}

function validEmail(value) {
  if (typeof value !== "string" || value.length > 254) return false;
  return /^[A-Z0-9.!#$%&'*+/=?^_{}|~-]+@[A-Z0-9-]+(?:\.[A-Z0-9-]+)+$/iu.test(value);
}

function luhnValid(value) {
  const digits = String(value).replace(/\D/gu, "");
  if (digits.length < 13 || digits.length > 19 || /^(\d)\1+$/u.test(digits)) return false;
  let sum = 0;
  let double = false;
  for (let index = digits.length - 1; index >= 0; index -= 1) {
    let digit = Number(digits[index]);
    if (double) {
      digit *= 2;
      if (digit > 9) digit -= 9;
    }
    sum += digit;
    double = !double;
  }
  return sum % 10 === 0;
}

function containsSensitiveData(value) {
  const text = String(value || "");
  if (
    /-----BEGIN [A-Z ]*PRIVATE KEY-----/u.test(text) ||
    /\b(?:sk|rk)_(?:live|test)_[A-Za-z0-9_-]{12,}\b/u.test(text) ||
    /\bnvapi-[A-Za-z0-9_-]{20,}\b/u.test(text) ||
    /\bsk-(?:proj-|ant-)?[A-Za-z0-9_-]{20,}\b/u.test(text) ||
    /\bgsk_[A-Za-z0-9_-]{20,}\b/u.test(text) ||
    /\bwhsec_[A-Za-z0-9_-]{12,}\b/u.test(text) ||
    /\bvercel_blob_rw_[A-Za-z0-9_-]{12,}\b/u.test(text) ||
    /\b(?:ghp|github_pat)_[A-Za-z0-9_]{20,}\b/u.test(text) ||
    /\bAKIA[0-9A-Z]{16}\b/u.test(text) ||
    /\b\d{3}-\d{2}-\d{4}\b/u.test(text) ||
    /\b(?:password|passwd|passcode|secret)\s*[:=]\s*\S{4,}/iu.test(text)
  ) return true;
  return (text.match(/(?:\d[ -]?){13,19}/gu) || []).some(luhnValid);
}

module.exports = async function supportTicket(request, response) {
  setHeaders(response);
  if (request.method !== "POST") {
    response.setHeader("Allow", "POST");
    return response.status(405).json({ error: "Method not allowed" });
  }
  const contentType = String(request.headers?.["content-type"] || "").split(";", 1)[0].trim().toLowerCase();
  if (contentType !== "application/json") {
    return response.status(415).json({ error: "Content-Type must be application/json" });
  }
  const declaredLength = Number(request.headers?.["content-length"] || 0);
  if (!Number.isSafeInteger(declaredLength) || declaredLength < 0) {
    return response.status(400).json({ error: "Invalid Content-Length" });
  }
  if (declaredLength > MAX_BODY_BYTES) {
    return response.status(413).json({ error: "Request too large" });
  }
  if (Object.keys(request.query || {}).length) {
    return response.status(400).json({ error: "Unexpected query parameters" });
  }
  let origin;
  try {
    origin = configuredOrigin();
  } catch {
    return response.status(503).json({ error: "Support is temporarily unavailable" });
  }
  const requestOrigin = String(request.headers?.origin || "");
  const fetchSite = String(request.headers?.["sec-fetch-site"] || "same-origin");
  if (requestOrigin !== origin || !["same-origin", "none"].includes(fetchSite)) {
    return response.status(403).json({ error: "Request origin was rejected" });
  }
  if (!await billing.limitRequest(request, response, "support")) return;

  let body;
  try {
    body = parseBody(request);
  } catch (error) {
    return response.status(error.message === "too_large" ? 413 : 400).json({ error: "Invalid ticket request" });
  }
  const expectedKeys = [
    "name", "email", "category", "platform", "appVersion", "subject",
    "description", "privacyAccepted", "companyWebsite", "startedAt", "submissionId",
  ];
  if (!hasExactKeys(body, expectedKeys)) {
    return response.status(400).json({ error: "Invalid ticket request" });
  }

  const submissionId = String(body.submissionId || "");
  const code = submissionId.slice(0, 8).toUpperCase();
  if (typeof body.companyWebsite !== "string") {
    return response.status(400).json({ error: "Invalid ticket request" });
  }
  if (body.companyWebsite) {
    return response.status(200).json({ ok: true, ticketId: code || "RECEIVED" });
  }
  const elapsed = Date.now() - body.startedAt;
  if (!Number.isSafeInteger(body.startedAt) || elapsed < 1000 || elapsed > 4 * 60 * 60 * 1000) {
    return response.status(400).json({ error: "Please review the ticket and try again" });
  }
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(submissionId)) {
    return response.status(400).json({ error: "Invalid ticket request" });
  }

  const name = singleLine(body.name, 80);
  const email = singleLine(body.email, 254)?.toLowerCase();
  const appVersion = optionalSingleLine(body.appVersion, 40);
  const subject = singleLine(body.subject, 120);
  const description = issueDescription(body.description);
  const category = CATEGORIES[body.category];
  const platform = PLATFORMS[body.platform];
  if (
    !name || !email || !validEmail(email) || appVersion === null || !subject || !description ||
    !category || !platform || body.privacyAccepted !== true
  ) {
    return response.status(400).json({ error: "Please complete every required field" });
  }
  if (containsSensitiveData(`${name}\n${email}\n${appVersion}\n${subject}\n${description}`)) {
    return response.status(400).json({
      error: "Remove passwords, payment-card numbers, private keys, or access tokens before submitting this ticket.",
    });
  }

  const ticket = {
    submissionId,
    code,
    categoryKey: body.category,
    category,
    platform,
    appVersion,
    name,
    email,
    subject,
    description,
  };
  try {
    await ticketStore.createTicket(ticket);
    return response.status(200).json({ ok: true, ticketId: code });
  } catch (error) {
    console.error("Support ticket storage failed", {
      type: "storage_failed",
    });
    return response.status(503).json({ error: "Your ticket could not be saved. Please try again shortly." });
  }
};

Object.assign(module.exports, { CATEGORIES, PLATFORMS, containsSensitiveData, luhnValid });
