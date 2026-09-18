// Recover this app's crashed UI without launching another process, reclaiming
// focus, replaying work, or interfering with an explicit quit/termination.
function keepWindowAvailable({ window, isQuitting, loadPage, onCrash, onStatus = () => {}, now = Date.now, schedule = setTimeout, cancel = clearTimeout }) {
  const contents = window.webContents;
  let stopped = false;
  let timer = null;
  let loading = false;
  let crashedWhileLoading = false;
  let attempts = [];
  const usable = () => !stopped && !isQuitting() && !window.isDestroyed();
  function recover() {
    if (!usable() || timer !== null || loading) return;
    attempts = attempts.filter(time => now() - time < 5 * 60000);
    if (attempts.length >= 3) { onStatus('paused'); return; }
    const delay = 1000 * 2 ** attempts.length;
    attempts.push(now());
    onStatus('recovering');
    timer = schedule(async () => {
      timer = null;
      if (!usable()) return;
      loading = true;
      crashedWhileLoading = false;
      let failed = false;
      try { await loadPage(); }
      catch { failed = true; }
      finally { loading = false; }
      if (!usable()) return;
      if (failed || crashedWhileLoading) recover();
      else onStatus('ready');
    }, delay);
  }
  function close(event) {
    if (!usable()) return;
    event.preventDefault();
    window.hide();
  }
  function gone(_event, details) {
    if (!usable()) return;
    onCrash();
    if (['crashed', 'oom', 'abnormal-exit', 'launch-failed'].includes(details.reason)) {
      if (loading) crashedWhileLoading = true;
      else recover();
    } else { stop(); onStatus('stopped'); }
  }
  const unresponsive = () => { if (usable()) onStatus('unresponsive'); };
  const responsive = () => { if (usable()) onStatus('ready'); };
  function stop() {
    if (stopped) return;
    stopped = true;
    if (timer !== null) cancel(timer);
    timer = null;
    window.removeListener('close', close);
    window.removeListener('unresponsive', unresponsive);
    window.removeListener('responsive', responsive);
    contents.removeListener('render-process-gone', gone);
  }
  window.on('close', close);
  window.on('unresponsive', unresponsive);
  window.on('responsive', responsive);
  window.once('closed', stop);
  contents.on('render-process-gone', gone);
  return { stop };
}
module.exports = { keepWindowAvailable };
