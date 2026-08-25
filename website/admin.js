(() => {
  const $ = (id) => document.getElementById(id);
  let tickets = [];
  let selectedId = "";

  function show(id) {
    ["loading-state", "sign-in-state", "denied-state", "admin-console"].forEach((candidate) => {
      $(candidate).hidden = candidate !== id;
    });
  }

  async function api(options = {}) {
    const response = await fetch("/api/admin-tickets", {
      ...options,
      credentials: "same-origin",
      headers: {
        Accept: "application/json",
        ...(options.body ? { "Content-Type": "application/json" } : {}),
      },
    });
    const result = await response.json().catch(() => ({}));
    if (!response.ok) {
      const error = new Error(result.error || "The admin request failed.");
      error.status = response.status;
      throw error;
    }
    return result;
  }

  function date(value, detailed = false) {
    const parsed = new Date(value);
    if (Number.isNaN(parsed.getTime())) return "Unknown";
    return new Intl.DateTimeFormat(undefined, detailed
      ? { dateStyle: "medium", timeStyle: "short" }
      : { month: "short", day: "numeric" }).format(parsed);
  }

  function statusLabel(status) {
    return status === "in_progress" ? "In progress" : status === "resolved" ? "Resolved" : "Open";
  }

  function updateCounts() {
    $("open-count").textContent = String(tickets.filter((ticket) => ticket.status === "open").length);
    $("progress-count").textContent = String(tickets.filter((ticket) => ticket.status === "in_progress").length);
    $("resolved-count").textContent = String(tickets.filter((ticket) => ticket.status === "resolved").length);
  }

  function renderAudit(ticket) {
    const list = $("audit-list");
    list.replaceChildren();
    [...ticket.audit].reverse().forEach((entry) => {
      const item = document.createElement("li");
      const time = document.createElement("time");
      time.dateTime = entry.at;
      time.textContent = date(entry.at, true);
      const body = document.createElement("div");
      const summary = document.createElement("p");
      summary.textContent = entry.action === "created"
        ? "Ticket created from the support form."
        : entry.action === "note"
          ? "Internal note added."
          : `Status changed from ${statusLabel(entry.from)} to ${statusLabel(entry.to)}.`;
      body.appendChild(summary);
      if (entry.note) {
        const note = document.createElement("em");
        note.textContent = entry.note;
        body.appendChild(note);
      }
      item.append(time, body);
      list.appendChild(item);
    });
  }

  function renderDetail() {
    const ticket = tickets.find((candidate) => candidate.submissionId === selectedId);
    $("empty-detail").hidden = Boolean(ticket);
    $("selected-detail").hidden = !ticket;
    if (!ticket) return;
    $("detail-code").textContent = `TICKET ${ticket.code}`;
    $("detail-subject").textContent = ticket.subject;
    $("detail-status").textContent = statusLabel(ticket.status);
    $("detail-name").textContent = ticket.name;
    $("detail-email").textContent = ticket.email;
    $("detail-email").href = `mailto:${ticket.email}`;
    $("detail-category").textContent = ticket.category;
    $("detail-platform").textContent = ticket.platform;
    $("detail-version").textContent = ticket.appVersion || "Not supplied";
    $("detail-date").textContent = date(ticket.createdAt, true);
    $("detail-description").textContent = ticket.description;
    $("ticket-status").value = ticket.status;
    $("ticket-note").value = "";
    $("reply-ticket").href = `mailto:${ticket.email}?subject=${encodeURIComponent(`[Drip Type ${ticket.code}] ${ticket.subject}`)}`;
    $("update-status").textContent = "";
    renderAudit(ticket);
  }

  function renderList() {
    updateCounts();
    const list = $("ticket-list");
    const filter = $("status-filter").value;
    const visible = tickets.filter((ticket) => filter === "all" || ticket.status === filter);
    list.replaceChildren();
    if (!visible.length) {
      const empty = document.createElement("p");
      empty.className = "no-tickets";
      empty.textContent = tickets.length ? "No tickets match this filter." : "No support tickets yet.";
      list.appendChild(empty);
    }
    visible.forEach((ticket) => {
      const button = document.createElement("button");
      button.type = "button";
      button.className = `ticket-row${ticket.submissionId === selectedId ? " active" : ""}`;
      button.dataset.status = ticket.status;
      const dot = document.createElement("span");
      dot.className = "dot";
      dot.setAttribute("aria-hidden", "true");
      const copy = document.createElement("span");
      const subject = document.createElement("strong");
      subject.textContent = ticket.subject;
      const meta = document.createElement("p");
      meta.textContent = `${ticket.code} · ${ticket.name} · ${statusLabel(ticket.status)}`;
      copy.append(subject, meta);
      const time = document.createElement("time");
      time.dateTime = ticket.createdAt;
      time.textContent = date(ticket.createdAt);
      button.append(dot, copy, time);
      button.addEventListener("click", () => {
        selectedId = ticket.submissionId;
        renderList();
        renderDetail();
      });
      list.appendChild(button);
    });
    renderDetail();
  }

  async function loadTickets() {
    $("refresh").disabled = true;
    $("console-status").textContent = "Loading tickets…";
    try {
      const result = await api();
      tickets = Array.isArray(result.tickets) ? result.tickets : [];
      if (selectedId && !tickets.some((ticket) => ticket.submissionId === selectedId)) selectedId = "";
      renderList();
      $("console-status").textContent = `${tickets.length} ticket${tickets.length === 1 ? "" : "s"}`;
    } catch (error) {
      if ([401, 403].includes(error.status)) {
        show(error.status === 401 ? "sign-in-state" : "denied-state");
      } else {
        $("console-status").textContent = error.message;
        $("console-status").classList.add("console-error");
      }
    } finally {
      $("refresh").disabled = false;
    }
  }

  $("ticket-update").addEventListener("submit", async (event) => {
    event.preventDefault();
    if (!selectedId) return;
    const button = $("save-ticket");
    button.disabled = true;
    $("update-status").textContent = "Saving secure update…";
    try {
      const result = await api({
        method: "PATCH",
        body: JSON.stringify({
          submissionId: selectedId,
          status: $("ticket-status").value,
          note: $("ticket-note").value,
        }),
      });
      tickets = tickets.map((ticket) => ticket.submissionId === selectedId ? result.ticket : ticket);
      renderList();
      $("update-status").textContent = "Update saved.";
    } catch (error) {
      $("update-status").textContent = error.message;
      $("update-status").classList.add("console-error");
    } finally {
      button.disabled = false;
    }
  });

  $("status-filter").addEventListener("change", renderList);
  $("refresh").addEventListener("click", loadTickets);
  async function signOut() {
    await fetch("/api/logout", {
      method: "POST",
      credentials: "same-origin",
      headers: { Accept: "application/json", "Content-Type": "application/json" },
      body: "{}",
    }).catch(() => {});
    show("sign-in-state");
    $("sign-out").hidden = true;
  }
  $("sign-out").addEventListener("click", signOut);
  $("denied-sign-out").addEventListener("click", signOut);

  async function boot() {
    try {
      const response = await fetch("/api/account-config", { headers: { Accept: "application/json" } });
      const config = await response.json();
      if (!response.ok || !config.configured) throw new Error("Accounts are unavailable.");
      $("sign-out").hidden = false;
      show("admin-console");
      await loadTickets();
    } catch (error) {
      show("denied-state");
      $("denied-copy").textContent = error.message || "The support console could not be loaded.";
    }
  }
  boot();
})();
