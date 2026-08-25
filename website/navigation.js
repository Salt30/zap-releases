(() => {
  const button = document.getElementById("mobile-menu-button");
  const menu = document.getElementById("mobile-menu");
  if (!button || !menu) return;

  const close = ({ restoreFocus = false } = {}) => {
    menu.hidden = true;
    button.setAttribute("aria-expanded", "false");
    button.setAttribute("aria-label", "Open navigation menu");
    if (restoreFocus) button.focus();
  };

  const open = () => {
    menu.hidden = false;
    button.setAttribute("aria-expanded", "true");
    button.setAttribute("aria-label", "Close navigation menu");
    menu.querySelector("a")?.focus();
  };

  button.addEventListener("click", () => {
    if (menu.hidden) open();
    else close();
  });
  menu.addEventListener("click", (event) => {
    if (event.target.closest("a")) close();
  });
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && !menu.hidden) close({ restoreFocus: true });
  });
  document.addEventListener("click", (event) => {
    if (!menu.hidden && !menu.contains(event.target) && !button.contains(event.target)) close();
  });
  window.matchMedia("(min-width: 681px)").addEventListener("change", (event) => {
    if (event.matches) close();
  });
})();
