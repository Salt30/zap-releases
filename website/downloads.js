(() => {
  const windows = /Windows/i.test(navigator.userAgentData?.platform || navigator.platform || navigator.userAgent || '');
  const href = windows
    ? 'https://drip-type-updates.vercel.app/Zap-1.8.0-windows.exe'
    : 'https://drip-type-updates.vercel.app/Zap-1.8.0-mac.dmg';
  const label = windows ? 'Download v1.8.0 for Windows ' : 'Download v1.8.0 for Mac ';
  document.querySelectorAll('[data-auto-download]').forEach((link) => {
    link.href = href;
    const text = [...link.childNodes].find((node) => node.nodeType === Node.TEXT_NODE);
    if (text) text.nodeValue = label;
  });
})();
