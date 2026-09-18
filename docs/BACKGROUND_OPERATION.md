# Zap background operation and window recovery

Closing the main Zap window now hides it while the menu-bar/system-tray app keeps
running. AI work and drafts remain in that window's memory. Open Zap from the tray
to return to the same session. The main window disables Electron's background
timer throttling so work can finish when the window is hidden or behind another
application. Other windows retain their normal throttling behavior.

The window recovery controller handles renderer crashes, out-of-memory failures
and launch failures. It reloads the trusted local app page, without raising or
focusing a hidden window. Three attempts are allowed within five minutes, with
one-, two- and four-second delays. Repeated failures stop recovery and notify the
user to quit and reopen Zap. Interrupted typing and AI requests are cancelled;
they are never replayed automatically. Drafts lost in a renderer crash cannot be
recovered from memory.

Quit Zap, update installation, and system termination remain effective. There is
no helper process, process respawning, signal suppression, new startup service,
process disguise, or attempt to take window priority from another application.
The existing user-controlled launch-at-login setting is unchanged. Sign-out still
clears device access and private in-memory work.

## Original Zap Pro modes

Neither Phantom mode nor Lockdown mode is included in the combined app. Inspection
of the installed original found screen-capture hiding, process disguise,
anti-termination persistence and mechanisms targeting lockdown software. Those
mechanisms have not been copied. Ordinary floating windows and background work
do not override operating-system or other applications' security restrictions.

## Verification

- `scripts/test-window-recovery.js`: close behavior, hidden recovery, retry limits,
  duplicate event suppression, disposal, explicit quit and termination handling.
- `npm run test:background`: real Electron window configuration, a timer completing
  after Close, a simulated crash notification reloading the local page without
  raising the window, and explicit teardown. It does not kill a real process.
- `npm run verify`: existing source, authentication, AI, website and build checks.

Verified on macOS Apple Silicon: source checks and the real Electron background
fixture pass, including the completed Quit event and process exit. Cleanup caches
the web-contents reference and runs only once, avoiding native-window access after
destruction. The regression fixture rejects that access explicitly. The local
preview is unsigned; Windows behavior and a signed public release remain unverified.

Main-process crashes require reopening Zap. An unresponsive renderer is observed
but is not automatically destroyed, because that could discard unsaved work.
No tests target exam software, capture hiding, or security-control evasion.
