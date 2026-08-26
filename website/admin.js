(() => {
  const $ = (id) => document.getElementById(id);
  let tickets = [];
  let selectedId = "";
  let activeView = "overview";

  function show(id) {
    ["loading-state", "sign-in-state", "denied-state", "admin-console"].forEach((candidate) => {
      $(candidate).hidden = candidate !== id;
    });
  }

  async function api(path, options = {}) {
    const response = await fetch(path, {
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

  function handleAccessError(error) {
    if (![401, 403].includes(error.status)) return false;
    show(error.status === 401 ? "sign-in-state" : "denied-state");
    if (error.status === 403) $("denied-copy").textContent = error.message;
    return true;
  }

  function date(value, detailed = false) {
    const parsed = new Date(value);
    if (Number.isNaN(parsed.getTime())) return "Never";
    return new Intl.DateTimeFormat(undefined, detailed
      ? { dateStyle: "medium", timeStyle: "short" }
      : { month: "short", day: "numeric", year: "numeric" }).format(parsed);
  }

  function number(value) {
    return Number.isFinite(Number(value)) ? new Intl.NumberFormat().format(Number(value)) : "—";
  }

  function money(cents, currency = "usd") {
    if (!Number.isFinite(Number(cents)) || currency === "mixed") return currency === "mixed" ? "Mixed" : "—";
    try {
      return new Intl.NumberFormat(undefined, {
        style: "currency",
        currency: String(currency || "usd").toUpperCase(),
        minimumFractionDigits: 0,
        maximumFractionDigits: 2,
      }).format(Number(cents) / 100);
    } catch {
      return `$${(Number(cents) / 100).toFixed(2)}`;
    }
  }

  function statusLabel(status) {
    if (status === "in_progress") return "In progress";
    if (status === "resolved") return "Resolved";
    if (status === "past_due") return "Past due";
    if (status === "trialing") return "Trial";
    if (status === "active") return "Active";
    if (status === "canceled") return "Canceled";
    return status === "free" || !status ? "Free" : String(status).replace(/_/gu, " ");
  }

  function setText(id, value) {
    $(id).textContent = String(value);
  }

  function renderTrend(trends, currency) {
    const chart = $("trend-chart");
    chart.replaceChildren();
    const rows = Array.isArray(trends) ? trends : [];
    const revenueMax = Math.max(1, ...rows.map((row) => Number(row.revenueCents || 0)));
    const signupMax = Math.max(1, ...rows.map((row) => Number(row.signups || 0)));
    rows.forEach((row) => {
      const column = document.createElement("div");
      column.className = "trend-column";
      const bars = document.createElement("div");
      bars.className = "trend-bars";
      const revenue = document.createElement("span");
      revenue.className = "trend-bar revenue-bar";
      revenue.style.height = `${Math.max(2, (Number(row.revenueCents || 0) / revenueMax) * 100)}%`;
      revenue.title = `${row.label} revenue: ${money(row.revenueCents, currency)}`;
      const signups = document.createElement("span");
      signups.className = "trend-bar signup-bar";
      signups.style.height = `${Math.max(2, (Number(row.signups || 0) / signupMax) * 100)}%`;
      signups.title = `${row.label} signups: ${number(row.signups)}`;
      const label = document.createElement("small");
      label.textContent = row.label;
      bars.append(revenue, signups);
      column.append(bars, label);
      chart.appendChild(column);
    });
  }

  function renderPlanMix(billing) {
    const core = Number(billing.planBreakdown?.core || 0);
    const pro = Number(billing.planBreakdown?.pro || 0);
    const total = core + pro;
    const corePercent = total ? Math.round((core / total) * 100) : 0;
    setText("plan-core", core);
    setText("plan-pro", pro);
    setText("plan-total", total);
    $("plan-ring").style.background = total
      ? `conic-gradient(var(--accent) 0 ${corePercent}%, var(--blue) ${corePercent}% 100%)`
      : "conic-gradient(#ffffff12 0 100%)";
    $("plan-note").textContent = billing.available
      ? "Plan totals include active and trialing subscriptions."
      : "Plan totals use the latest saved account entitlement state until Stripe reporting is available.";
  }

  function renderAccounts(accounts) {
    const body = $("account-table-body");
    body.replaceChildren();
    const recent = Array.isArray(accounts.recent) ? accounts.recent : [];
    $("account-table-empty").hidden = Boolean(recent.length);
    recent.forEach((account) => {
      const row = document.createElement("tr");
      const email = document.createElement("td");
      email.textContent = account.email;
      const plan = document.createElement("td");
      plan.textContent = account.plan
        ? account.plan[0].toUpperCase() + account.plan.slice(1)
        : account.status && account.status !== "free" ? "Unmapped" : "Free";
      const status = document.createElement("td");
      const badge = document.createElement("span");
      badge.className = `account-status status-${["active", "trialing", "past_due", "canceled", "free"].includes(account.status) ? account.status : "other"}`;
      badge.textContent = statusLabel(account.status);
      status.appendChild(badge);
      const joined = document.createElement("td");
      joined.textContent = date(account.createdAt);
      const active = document.createElement("td");
      active.textContent = date(account.lastLoginAt);
      row.append(email, plan, status, joined, active);
      body.appendChild(row);
    });
    $("account-table-note").textContent = `${number(Math.min(50, recent.length))} shown · ${number(accounts.total)} total`;
  }

  function renderOverview(data) {
    const accounts = data.accounts || {};
    const billing = data.billing || {};
    const support = data.support || {};
    const currency = billing.currency || "usd";
    setText("kpi-users", number(accounts.total));
    setText("kpi-users-note", `${number(accounts.new30d)} joined in the last 30 days`);
    setText("kpi-mrr", money(billing.mrrCents, currency));
    setText("kpi-revenue", money(billing.collectedRevenueCents, currency));
    setText("kpi-subscribers", number(billing.activeSubscriptions));
    setText("kpi-conversion", `${Number(accounts.conversionRate || 0).toFixed(1)}%`);
    setText("kpi-revenue-30", money(billing.revenue30dCents, currency));
    setText("health-new-users", number(accounts.new7d));
    setText("health-active-users", number(accounts.active30d));
    setText("health-trials", number(billing.trials));
    setText("health-past-due", number(billing.pastDue));
    setText("health-canceling", number(billing.pendingCancellation));
    setText("health-canceled", number(billing.cancelled30d));
    setText("health-failed", number(billing.failedPayments30d));
    setText("health-refunds", money(billing.refundsCents, currency));
    setText("health-devices", number(billing.activeDevices));
    setText("health-support", support.available ? number(support.open + support.inProgress) : "—");
    $("support-tab-count").textContent = support.available ? String(support.open + support.inProgress) : "—";
    $("billing-alert").hidden = Boolean(billing.available && !billing.message && billing.complete);
    if (!$("billing-alert").hidden) {
      $("billing-alert-copy").textContent = billing.message || (billing.complete
        ? "Review the billing currency configuration."
        : "The Stripe result was capped or unavailable; some billing totals may be incomplete.");
    }
    $("kpi-mrr-note").textContent = billing.available ? "Active paid subscriptions" : "Stripe permission required";
    $("kpi-revenue-note").textContent = billing.available ? "Captured payments minus refunds" : "Stripe permission required";
    $("kpi-subscribers-note").textContent = `${number(billing.planBreakdown?.core)} Core · ${number(billing.planBreakdown?.pro)} Pro`;
    renderTrend(data.trends, currency);
    renderPlanMix(billing);
    renderAccounts(accounts);
    setText("data-freshness", `Updated ${date(data.generatedAt, true)}`);
  }

  async function loadOverview() {
    try {
      const data = await api("/api/admin-stats");
      renderOverview(data);
      return true;
    } catch (error) {
      if (handleAccessError(error)) throw error;
      $("billing-alert").hidden = false;
      $("billing-alert-copy").textContent = error.message;
      return false;
    }
  }

  function updateCounts() {
    const open = tickets.filter((ticket) => ticket.status === "open").length;
    const progress = tickets.filter((ticket) => ticket.status === "in_progress").length;
    setText("open-count", open);
    setText("progress-count", progress);
    setText("resolved-count", tickets.filter((ticket) => ticket.status === "resolved").length);
    setText("support-tab-count", open + progress);
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
    setText("detail-code", `TICKET ${ticket.code}`);
    setText("detail-subject", ticket.subject);
    setText("detail-status", statusLabel(ticket.status));
    setText("detail-name", ticket.name);
    setText("detail-email", ticket.email);
    $("detail-email").href = `mailto:${ticket.email}`;
    setText("detail-category", ticket.category);
    setText("detail-platform", ticket.platform);
    setText("detail-version", ticket.appVersion || "Not supplied");
    setText("detail-date", date(ticket.createdAt, true));
    setText("detail-description", ticket.description);
    $("ticket-status").value = ticket.status;
    $("ticket-note").value = "";
    $("reply-ticket").href = `mailto:${ticket.email}?subject=${encodeURIComponent(`[Drip Type ${ticket.code}] ${ticket.subject}`)}`;
    setText("update-status", "");
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
    setText("ticket-status-copy", "Loading tickets…");
    try {
      const result = await api("/api/admin-tickets");
      tickets = Array.isArray(result.tickets) ? result.tickets : [];
      if (selectedId && !tickets.some((ticket) => ticket.submissionId === selectedId)) selectedId = "";
      renderList();
      setText("ticket-status-copy", `${tickets.length} ticket${tickets.length === 1 ? "" : "s"}`);
      return true;
    } catch (error) {
      if (handleAccessError(error)) throw error;
      setText("ticket-status-copy", error.message);
      $("ticket-status-copy").classList.add("console-error");
      return false;
    }
  }

  async function refreshAll() {
    $("refresh").disabled = true;
    setText("console-status", "Refreshing…");
    try {
      const results = await Promise.all([loadOverview(), loadTickets()]);
      if ($("admin-console").hidden) return;
      setText("console-status", results.every(Boolean) ? "All data current" : "Some data needs attention");
    } catch {
      // Access-state handling already moved the interface to the correct screen.
    } finally {
      $("refresh").disabled = false;
    }
  }

  function selectView(view) {
    activeView = view === "support" ? "support" : "overview";
    $("overview-view").hidden = activeView !== "overview";
    $("support-view").hidden = activeView !== "support";
    document.querySelectorAll("[data-view]").forEach((button) => {
      const active = button.dataset.view === activeView;
      button.classList.toggle("active", active);
      button.setAttribute("aria-selected", String(active));
    });
  }

  $("ticket-update").addEventListener("submit", async (event) => {
    event.preventDefault();
    if (!selectedId) return;
    const button = $("save-ticket");
    button.disabled = true;
    setText("update-status", "Saving secure update…");
    try {
      const result = await api("/api/admin-tickets", {
        method: "PATCH",
        body: JSON.stringify({ submissionId: selectedId, status: $("ticket-status").value, note: $("ticket-note").value }),
      });
      tickets = tickets.map((ticket) => ticket.submissionId === selectedId ? result.ticket : ticket);
      renderList();
      setText("update-status", "Update saved.");
      await loadOverview();
    } catch (error) {
      setText("update-status", error.message);
      $("update-status").classList.add("console-error");
    } finally {
      button.disabled = false;
    }
  });

  $("status-filter").addEventListener("change", renderList);
  $("refresh").addEventListener("click", refreshAll);
  document.querySelectorAll("[data-view]").forEach((button) => button.addEventListener("click", () => selectView(button.dataset.view)));

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
      selectView(activeView);
      await refreshAll();
    } catch (error) {
      if (!handleAccessError(error)) {
        show("denied-state");
        $("denied-copy").textContent = error.message || "The admin dashboard could not be loaded.";
      }
    }
  }
  boot();
})();
