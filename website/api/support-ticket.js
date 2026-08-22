const { randomUUID } = require("node:crypto");

const SUPPORT_INBOX = "support@tryzap.net";
const SUPPORT_SENDER = "Drip Type Tickets <tickets@tryzap.net>";
const MAX_BODY_BYTES = 12_000;
const RATE_WINDOW_MS = 10 * 60 * 1000;
const RATE_LIMIT = 5;
const rateLimits = new Map();

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

function clientAddress(request) {
  return String(request.headers?.["x-forwarded-for"] || request.socket?.remoteAddress || "unknown")
    .split(",")[0]
    .trim()
    .slice(0, 128);
}

function rateLimited(request) {
  const now = Date.now();
  const key = clientAddress(request);
  const current = rateLimits.get(key);
  if (!current || now - current.startedAt >= RATE_WINDOW_MS) {
    rateLimits.set(key, { startedAt: now, count: 1 });
    if (rateLimits.size > 2000) {
      for (const [candidate, value] of rateLimits) {
        if (now - value.startedAt >= RATE_WINDOW_MS) rateLimits.delete(candidate);
      }
    }
    return false;
  }
  current.count += 1;
  return current.count > RATE_LIMIT;
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

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function emailText(ticket) {
  return [
    `New Drip Type support ticket ${ticket.code}`,
    "",
    `Category: ${ticket.category}`,
    `Platform: ${ticket.platform}`,
    `App version: ${ticket.appVersion || "Not supplied"}`,
    `Name: ${ticket.name}`,
    `Email: ${ticket.email}`,
    `Subject: ${ticket.subject}`,
    "",
    "Issue:",
    ticket.description,
    "",
    `Submitted: ${ticket.submittedAt}`,
    `Ticket ID: ${ticket.submissionId}`,
    "",
    "Reply to this message to respond directly to the customer.",
  ].join("\n");
}

function emailHtml(ticket) {
  const row = (label, value) => `<tr><td style="padding:7px 14px 7px 0;color:#6b7280;vertical-align:top">${label}</td><td style="padding:7px 0;color:#111827">${escapeHtml(value)}</td></tr>`;
  return `<!doctype html><html><body style="margin:0;background:#f5f5f4;font-family:Arial,sans-serif;color:#111827"><div style="max-width:680px;margin:0 auto;padding:32px 20px"><div style="background:#111217;border-top:4px solid #ffd24d;padding:28px;color:#f4f3ee"><div style="font-size:12px;letter-spacing:.12em;text-transform:uppercase;color:#ffd24d">Drip Type by Zap</div><h1 style="margin:12px 0 0;font-size:26px">Support ticket ${ticket.code}</h1></div><div style="background:#fff;padding:28px"><table style="border-collapse:collapse;width:100%;font-size:14px">${row("Category", ticket.category)}${row("Platform", ticket.platform)}${row("App version", ticket.appVersion || "Not supplied")}${row("Name", ticket.name)}${row("Email", ticket.email)}${row("Subject", ticket.subject)}</table><h2 style="font-size:16px;margin:28px 0 10px">Issue</h2><div style="white-space:pre-wrap;background:#f5f5f4;border:1px solid #e7e5e4;padding:18px;font-size:14px;line-height:1.6">${escapeHtml(ticket.description)}</div><p style="margin:24px 0 0;color:#6b7280;font-size:12px">Submitted ${escapeHtml(ticket.submittedAt)} · ${escapeHtml(ticket.submissionId)}</p><p style="margin:10px 0 0;color:#6b7280;font-size:12px">Reply to this email to respond directly to the customer.</p></div></div></body></html>`;
}

async function sendTicket(ticket) {
  const apiKey = process.env.RESEND_API_KEY || "";
  if (!/^re_[A-Za-z0-9_-]{20,}$/u.test(apiKey)) throw new Error("email_not_configured");
  const result = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
      "Idempotency-Key": `support-ticket/${ticket.submissionId}`,
      "User-Agent": "DripType-Support/1.0",
    },
    body: JSON.stringify({
      from: SUPPORT_SENDER,
      to: [SUPPORT_INBOX],
      reply_to: ticket.email,
      subject: `[Drip Type ${ticket.code}] ${ticket.category}: ${ticket.subject}`,
      text: emailText(ticket),
      html: emailHtml(ticket),
      tags: [
        { name: "source", value: "support-form" },
        { name: "category", value: ticket.categoryKey },
      ],
    }),
    signal: AbortSignal.timeout(12_000),
  });
  const payload = await result.json().catch(() => ({}));
  if (!result.ok || !/^[0-9a-f-]{20,}$/iu.test(String(payload.id || ""))) {
    const error = new Error("email_delivery_failed");
    error.status = result.status;
    error.type = payload?.name || payload?.type || "resend_error";
    throw error;
  }
  return payload.id;
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
  if (rateLimited(request)) {
    response.setHeader("Retry-After", "600");
    return response.status(429).json({ error: "Too many tickets. Please wait and try again." });
  }

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
    submittedAt: new Date().toISOString(),
  };
  try {
    await sendTicket(ticket);
    return response.status(200).json({ ok: true, ticketId: code });
  } catch (error) {
    console.error("Support ticket delivery failed", {
      status: Number(error.status || 0),
      type: String(error.type || error.message || "delivery_failed").slice(0, 80),
    });
    return response.status(503).json({ error: "Your ticket could not be delivered. Please try again shortly." });
  }
};

Object.assign(module.exports, { CATEGORIES, PLATFORMS });
