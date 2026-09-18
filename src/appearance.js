// One appearance controller for every window. Native controls and web content
// follow the same preference, including live macOS accessibility changes.
function createAppearance(onPreference = () => {}) {
  let preference = 'system';
  const scheme = window.matchMedia('(prefers-color-scheme: dark)');
  const transparency = window.matchMedia('(prefers-reduced-transparency: reduce)');
  const contrast = window.matchMedia('(prefers-contrast: more)');
  function apply(value = preference, native = {}) {
    preference = ['system', 'light', 'dark'].includes(value) ? value : 'system';
    const root = document.documentElement;
    root.dataset.theme = native.resolvedTheme || (preference === 'system' ? (scheme.matches ? 'dark' : 'light') : preference);
    root.dataset.reducedTransparency = String(native.reducedTransparency ?? transparency.matches);
    root.dataset.highContrast = String(native.highContrast ?? contrast.matches);
    if (native.platform) root.dataset.platform = native.platform;
    onPreference(preference);
  }
  window.dripType.onTheme((state) => apply(state.theme, state));
  [scheme, transparency, contrast].forEach((query) => query.addEventListener('change', () => {
    window.dripType.getAppearance().then((state) => apply(state.theme, state)).catch(() => apply());
  }));
  window.dripType.getAppearance().then((state) => apply(state.theme, state)).catch(() => apply());
  apply();
  return apply;
}

module.exports = { createAppearance };
