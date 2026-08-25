const { get, list, put } = require("@vercel/blob");

const PREFIX = "support-tickets/";
const MAX_TICKET_BYTES = 32_000;
const MAX_LIST_RESULTS = 100;
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
  return (token.length >= 32 && token.length <= 4096) ||
    (/^store_[A-Za-z0-9]+$/u.test(process.env.BLOB_STORE_ID || "") && Boolean(process.env.VERCEL_OIDC_TOKEN));
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
  const ticket = validateStoredTicket(JSON.parse(await streamText(result.stream)));
  return { ticket, etag: result.blob.etag };
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
  const body = JSON.stringify(stored);
  if (Buffer.byteLength(body, "utf8") > MAX_TICKET_BYTES) throw new Error("ticket_too_large");
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

async function listTickets() {
  if (!storageConfigured()) throw new Error("ticket_storage_not_configured");
  const result = await list({ prefix: PREFIX, limit: 1000 });
  const candidates = result.blobs
    .filter((blob) => blob.pathname.endsWith(".json") && blob.size <= MAX_TICKET_BYTES)
    .sort((left, right) => right.uploadedAt.getTime() - left.uploadedAt.getTime())
    .slice(0, MAX_LIST_RESULTS);
  const tickets = [];
  for (let index = 0; index < candidates.length; index += 10) {
    const batch = candidates.slice(index, index + 10);
    const records = await Promise.all(batch.map(async (blob) => {
      try {
        const id = blob.pathname.slice(PREFIX.length, -5);
        const record = await readTicket(id);
        return record?.ticket || null;
      } catch {
        return null;
      }
    }));
    tickets.push(...records.filter(Boolean));
  }
  return tickets.sort((left, right) => String(right.createdAt).localeCompare(String(left.createdAt)));
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
  const body = JSON.stringify(updated);
  if (Buffer.byteLength(body, "utf8") > MAX_TICKET_BYTES) throw new Error("ticket_too_large");
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
  STATUSES,
  createTicket,
  listTickets,
  readTicket,
  storageConfigured,
  updateTicket,
  validId,
};
