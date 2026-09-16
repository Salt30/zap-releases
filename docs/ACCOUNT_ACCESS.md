# Secure Zap sign-in and sign-out

## Using it

Open **Billing → Sign in** in Zap. Your system browser opens the fixed
`https://tryzap.net/account` page. Sign in or create an account there, then choose
**Connect app** for your active subscription. Passwords never enter Electron or
its renderer. When connected, the controls become **View account** and **Sign out**.

**Sign out** immediately disables local paid access, stops typing and AI work,
closes the composer and pinned answers, and clears in-memory drafts, screenshots,
AI history and custom AI context. It removes the OS-protected device credential
and asks the server to revoke that credential. It does not cancel the subscription.
Personal typing/appearance preferences are retained.

Desktop and browser sessions are separate. Use **Sign out** on the account website
to end that browser session as well. Website sign-out invalidates the session on
the server before expiring its Secure, HttpOnly cookie. Other browser sessions
normally remain active; exceeding the bounded revocation record invalidates all
older sessions rather than dropping revocations.

## Security boundaries

- A random sign-in state is retained in main-process memory for ten minutes.
  Only a matching callback for the pending attempt can connect the device.
- A separate random verifier stays in the main process. Only its SHA-256 challenge
  goes through the browser; the server signs that challenge into the five-minute
  activation token and requires the verifier before issuing a refresh credential.
  This applies PKCE-style proof to the existing signed activation flow.
- Activation responses are signature-checked and bound to the device. Replay,
  wrong-state and expired pending attempts are rejected. Previously released
  clients retain their legacy activation format; the new client requires state
  and proof binding.
- Credentials remain in macOS Keychain or Windows protected storage. The renderer
  receives account status and operation results, never a password or refresh token.
- Signing out changes the account generation before any network wait. Late
  refreshes, activation writes, billing-portal responses and AI responses cannot
  restore the signed-out session or display a previous account's results.
- The signed-out marker persists across restarts. If OS credential deletion fails,
  access remains disabled and the UI offers sign-out again to retry cleanup.
- Online device revocation clears only the matching device/credential slot on the
  subscription. Other devices remain connected. Browser logout records session
  revocation in encrypted private account storage, with conditional writes.
- Existing origin validation, input bounds, password hashing, lockouts and shared
  request limits remain in place. Logout failures are reported instead of being
  silently presented as success.

Server invalidation follows
[OWASP session-management guidance](https://cheatsheetseries.owasp.org/cheatsheets/Session_Management_Cheat_Sheet.html#manual-session-expiration).

## Limits

Offline desktop sign-out clears local access, but cannot promise remote revocation.
The app reports that distinction; reconnecting online rotates the old device
credential. A copied, previously issued offline entitlement may remain valid until
its existing expiry. A concurrent activation from an older client can require
reconnecting if it races with device-slot revocation.

The packaged Apple Silicon preview is unsigned. A signed release is needed to
deliver these desktop controls through the public update channel. Provider-key
rotation and server-side NVIDIA setup remain separate outstanding work.

## Verification

`npm run verify` includes `scripts/test-account-session.js`: pending-state and
proof checks, replay rejection, refresh/activation/storage-write races, cleanup
failures, offline logout, copied-cookie invalidation, unrelated-session isolation,
origin rejection and device revocation. The desktop fixture exercises the visible
controls and clears drafts and AI history while cancelling an in-flight request.
Tests use synthetic credentials and mocked storage/provider calls.

### September 15 verification and rollout

- Source/authentication suite and packaged-app security verification passed.
- Desktop account controls, logout during AI work, and private-data clearing
  passed in the account-focused UI run. The unrelated native macOS fullscreen
  assertion failed in the full suite and was explicitly skipped for that focused
  run; fullscreen behavior is not claimed as verified by this change.
- Live website: account config 200; logout without a session 200 with cookie
  expiry; cross-origin logout 403; malformed device disconnect 400; unauthenticated
  proof-bound activation 401; backend source 404.
- Production deployment: https://drip-type-qfoezgv8e-salt30s-projects.vercel.app,
  aliased to https://tryzap.net; ready in 28 seconds. Static site with Node 22
  serverless APIs, deployed from local changes on top of `a0bf7d1`.
- No customer credentials or purchases were used for the production checks.
