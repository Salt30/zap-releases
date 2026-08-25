const { del, get, list, put } = require("@vercel/blob");
const { createCipheriv, createDecipheriv, randomBytes } = require("node:crypto");

const PREFIX = "support-tickets/";
const MAX_TICKET_BYTES = 32_000;
const MAX_BLOB_BYTES = MAX_TICKET_BYTES + 2_000;
const MAX_LIST_RESULTS = 100;
const RETENTION_MS = 90 * 24 * 60 * 60 * 1000;
const STATUSES = new Set(["open", "in_progress", "resolved"]);

function validId(value) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(
    String(value || ""),
  );
}

function pathname(id) {
  if (!validId(id)) throw new Error("invalid_ticket_id");
  return `${PREFIX}${String(id).toLowerCase()}.json`;
}

function storageConfigured() {
  const token = process.env.BLOB_READ_WRITE_TOKEN || "";
  const blobConfigured = (token.length >= 32 && token.length <= 4096) ||
    /^store_[A-Za-z0-9]+$/u.test(process.env.BLOB_STORE_ID || "");
  return blobConfigured && Boolean(supportDataKey());
}

function supportDataKey() {
  const encoded = String(process.env.SUPPORT_DATA_KEY || "").trim();
  if (!/^[A-Za-z0-9_-]{43}$/u.test(encoded)) return null;
  try {
    const key = Buffer.from(encoded, "base64url");
    return key.length === 32 ? key : null;
  } catch {
    return null;
  }
}

function encodeTicket(ticket) {
  const key = supportDataKey();
  if (!key) throw new Error("ticket_encryption_not_configured");
  const plaintext = Buffer.from(JSON.stringify(ticket), "utf8");
  if (plaintext.byteLength > MAX_TICKET_BYTES) throw new Error("ticket_too_large");
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  cipher.setAAD(Buffer.from(pathname(ticket.submissionId), "utf8"));
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  return JSON.stringify({
    version: 1,
    algorithm: "A256GCM",
    iv: iv.toString("base64url"),
    tag: cipher.getAuthTag().toString("base64url"),
    ciphertext: ciphertext.toString("base64url"),
  });
}

function decodeTicket(value, id) {
  const record = JSON.parse(value);
  if (record?.version !== 1 || record?.algorithm !== "A256GCM") {
    return validateStoredTicket(record);
  }
  if (
    typeof record.iv !== "string" || typeof record.tag !== "string" ||
    typeof record.ciphertext !== "string" || record.ciphertext.length > MAX_BLOB_BYTES * 2
  ) throw new Error("invalid_encrypted_ticket");
  const key = supportDataKey();
  if (!key) throw new Error("ticket_encryption_not_configured");
  try {
    const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(record.iv, "base64url"));
    decipher.setAAD(Buffer.from(pathname(id), "utf8"));
    decipher.setAuthTag(Buffer.from(record.tag, "base64url"));
    const plaintext = Buffer.concat([
      decipher.update(Buffer.from(record.ciphertext, "base64url")),
      decipher.final(),
    ]);
    if (plaintext.byteLength > MAX_TICKET_BYTES) throw new Error("ticket_too_large");
    const ticket = validateStoredTicket(JSON.parse(plaintext.toString("utf8")));
    if (ticket.submissionId.toLowerCase() !== String(id).toLowerCase()) throw new Error("ticket_id_mismatch");
    return ticket;
  } catch (error) {
    if (error.message === "ticket_too_large" || error.message === "ticket_id_mismatch") throw error;
    throw new Error("ticket_decryption_failed");
  }
}

function isEncryptedTicket(value) {
  try {
    const record = JSON.parse(value);
    return record?.version === 1 && record?.algorithm === "A256GCM";
  } catch {
    return false;
  }
}

async function streamText(stream, maximumBytes = MAX_TICKET_BYTES) {
  if (!stream) throw new Error("ticket_not_found");
  const reader = stream.getReader();
  const chunks = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maximumBytes) throw new Error("ticket_too_large");
      chunks.push(Buffer.from(value));
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks).toString("utf8");
}

function validateStoredTicket(ticket) {
  if (!ticket || typeof ticket !== "object" || Array.isArray(ticket) || !validId(ticket.submissionId)) {
    throw new Error("invalid_stored_ticket");
  }
  if (!STATUSES.has(ticket.status) || !Array.isArray(ticket.audit) || ticket.audit.length > 100) {
    throw new Error("invalid_stored_ticket");
  }
  return ticket;
}

async function readTicket(id) {
  const result = await get(pathname(id), { access: "private", useCache: false });
  if (!result || result.statusCode !== 200) return null;
  const raw = await streamText(result.stream, MAX_BLOB_BYTES);
  const encrypted = isEncryptedTicket(raw);
  const ticket = decodeTicket(raw, id);
  const createdAt = new Date(ticket.createdAt).getTime();
  if (!Number.isFinite(createdAt) || Date.now() - createdAt > RETENTION_MS) {
    await del(pathname(id), { ifMatch: result.blob.etag });
    return null;
  }
  let etag = result.blob.etag;
  if (!encrypted) {
    const migrated = await put(pathname(id), encodeTicket(ticket), {
      access: "private",
      addRandomSuffix: false,
      allowOverwrite: true,
      ifMatch: etag,
      cacheControlMaxAge: 60,
      contentType: "application/json; charset=utf-8",
    });
    etag = migrated.etag;
  }
  return { ticket, etag, migrated: !encrypted };
}

async function createTicket(ticket) {
  if (!storageConfigured()) throw new Error("ticket_storage_not_configured");
  const createdAt = new Date().toISOString();
  const stored = validateStoredTicket({
    ...ticket,
    submittedAt: createdAt,
    createdAt,
    updatedAt: createdAt,
    status: "open",
    audit: [{ action: "created", at: createdAt, actor: "support-form" }],
  });
  const body = encodeTicket(stored);
  try {
    await put(pathname(stored.submissionId), body, {
      access: "private",
      addRandomSuffix: false,
      allowOverwrite: false,
      cacheControlMaxAge: 60,
      contentType: "application/json; charset=utf-8",
    });
  } catch (error) {
    if (error?.name !== "BlobPreconditionFailedError") throw error;
  }
  return stored;
}

async function listAllTicketBlobs() {
  const blobs = [];
  let cursor;
  const seenCursors = new Set();
  do {
    const result = await list({ prefix: PREFIX, limit: 1000, ...(cursor ? { cursor } : {}) });
    blobs.push(...result.blobs.filter((blob) => blob.pathname.endsWith(".json") && blob.size <= MAX_BLOB_BYTES));
    if (!result.hasMore) break;
    if (!result.cursor || seenCursors.has(result.cursor)) throw new Error("invalid_ticket_cursor");
    seenCursors.add(result.cursor);
    cursor = result.cursor;
  } while (cursor);
  return blobs;
}

async function ticketRecords(blobs) {
  const tickets = [];
  let migrated = 0;
  for (let index = 0; index < blobs.length; index += 10) {
    const batch = blobs.slice(index, index + 10);
    const records = await Promise.all(batch.map(async (blob) => {
      try {
        const id = blob.pathname.slice(PREFIX.length, -5);
        return await readTicket(id);
      } catch {
        return null;
      }
    }));
    records.filter(Boolean).forEach((record) => {
      tickets.push(record.ticket);
      if (record.migrated) migrated += 1;
    });
  }
  return { tickets, migrated };
}

async function purgeExpiredTickets() {
  if (!storageConfigured()) throw new Error("ticket_storage_not_configured");
  const blobs = await listAllTicketBlobs();
  const { tickets, migrated } = await ticketRecords(blobs);
  return { scanned: blobs.length, retained: tickets.length, deleted: blobs.length - tickets.length, migrated };
}

async function listTickets() {
  if (!storageConfigured()) throw new Error("ticket_storage_not_configured");
  const blobs = await listAllTicketBlobs();
  const candidates = blobs
    .sort((left, right) => right.uploadedAt.getTime() - left.uploadedAt.getTime());
  const { tickets } = await ticketRecords(candidates);
  return tickets
    .sort((left, right) => String(right.createdAt).localeCompare(String(left.createdAt)))
    .slice(0, MAX_LIST_RESULTS);
}

async function updateTicket({ submissionId, status, note }, actor) {
  if (!storageConfigured()) throw new Error("ticket_storage_not_configured");
  if (!validId(submissionId) || !STATUSES.has(status)) throw new Error("invalid_ticket_update");
  const normalizedNote = typeof note === "string" ? note.replace(/\r\n?/gu, "\n").trim() : "";
  if (normalizedNote.length > 2000 || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(normalizedNote)) {
    throw new Error("invalid_ticket_update");
  }
  const existing = await readTicket(submissionId);
  if (!existing) throw new Error("ticket_not_found");
  const updatedAt = new Date().toISOString();
  const updated = validateStoredTicket({
    ...existing.ticket,
    status,
    updatedAt,
    audit: [...existing.ticket.audit, {
      action: status === existing.ticket.status ? "note" : "status_changed",
      from: existing.ticket.status,
      to: status,
      note: normalizedNote,
      at: updatedAt,
      actor: String(actor?.userId || "admin").slice(0, 80),
    }].slice(-100),
  });
  const body = encodeTicket(updated);
  await put(pathname(submissionId), body, {
    access: "private",
    addRandomSuffix: false,
    allowOverwrite: true,
    ifMatch: existing.etag,
    cacheControlMaxAge: 60,
    contentType: "application/json; charset=utf-8",
  });
  return updated;
}

module.exports = {
  MAX_LIST_RESULTS,
  RETENTION_MS,
  STATUSES,
  createTicket,
  decodeTicket,
  encodeTicket,
  isEncryptedTicket,
  listTickets,
  listAllTicketBlobs,
  purgeExpiredTickets,
  readTicket,
  storageConfigured,
  supportDataKey,
  updateTicket,
  validId,
};
