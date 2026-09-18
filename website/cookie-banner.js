(() => {
  "use strict";

  const storageKey = "zap_cookie_notice_acknowledged_v1";

  function wasAcknowledged() {
    try {
      return window.localStorage.getItem(storageKey) === "yes";
    } catch {
      return false;
    }
  }

  function rememberAcknowledgement() {
    try {
      window.localStorage.setItem(storageKey, "yes");
    } catch {
      // The notice can still be dismissed for this page when storage is blocked.
    }
  }

  function createNotice() {
    if (wasAcknowledged() || document.querySelector(".cookie-notice")) return;

    const notice = document.createElement("aside");
    notice.className = "cookie-notice is-entering";
    notice.setAttribute("aria-label", "Cookie and local storage notice");
    notice.setAttribute("role", "region");

    const inner = document.createElement("div");
    inner.className = "cookie-notice__inner";

    const copy = document.createElement("div");
    copy.className = "cookie-notice__copy";

    const label = document.createElement("span");
    label.className = "cookie-notice__label";
    label.textContent = "Necessary only";

    const message = document.createElement("p");
    message.textContent = "We use essential storage for secure sign-in, checkout continuity, and remembering this notice. No advertising or cross-site tracking.";

    const actions = document.createElement("div");
    actions.className = "cookie-notice__actions";

    const privacy = document.createElement("a");
    privacy.className = "cookie-notice__privacy";
    privacy.href = "/privacy#cookies";
    privacy.textContent = "Privacy";

    const dismiss = document.createElement("button");
    dismiss.className = "cookie-notice__dismiss";
    dismiss.type = "button";
    dismiss.textContent = "Got it";

    dismiss.addEventListener("click", () => {
      rememberAcknowledgement();
      notice.classList.add("is-leaving");
      window.setTimeout(() => notice.remove(), 190);
    });

    copy.append(label, message);
    actions.append(privacy, dismiss);
    inner.append(copy, actions);
    notice.append(inner);
    document.body.append(notice);
    window.requestAnimationFrame(() => notice.classList.remove("is-entering"));
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", createNotice, { once: true });
  } else {
    createNotice();
  }
})();
