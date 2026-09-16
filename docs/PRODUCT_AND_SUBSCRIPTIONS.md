# Zap — product and subscriptions

Zap has two main features: **Zap AI** and **Drip Type**. Drip Type opens with
Option+5 on Mac or Alt+5 on Windows. Option/Alt+0 stops typing.

Templates, Pro Studio, Profiles, and the Clipboard workspace are retired. They
have no navigation pages, preload methods, or privileged IPC handlers in the new
app. Existing saved data remains untouched. Standalone training work is outside
the desktop bundle.

## Plans

New purchases offer **Zap Core — $9.99 USD/month**. There is no free trial.
Existing Pro subscriptions can still activate, refresh, and open their billing
portal. This change does not cancel or modify existing Stripe subscriptions.
Legacy feature claims remain recognizable for older released desktop clients;
they grant no retired feature access in this build because the handlers are gone.

## AI usage

- Active, device-connected subscription required for every inference request.
- NVIDIA key exists only on the server; clients cannot pick a provider URL/model.
- 100 requests per subscription per UTC day; 10 requests per minute.
- 20 requests per IP per minute, plus a 10,000-request shared daily service ceiling.
- Failed or cancelled submissions may consume a reservation. Limits are enforced
  with shared conditional-write counters and fail closed if storage is unavailable.
- Text, custom instructions and attached screenshots are sent through Zap to NVIDIA
  only when submitted. AI is subject to provider and service availability.
- Drip Type drafts and keystroke generation run locally.

## Activation

Stripe prices and active status are verified server-side. Ed25519-signed
entitlements bind to a hashed device identifier and expire after 72 hours.
Up to three devices can activate. Refresh credentials use Keychain on macOS and
DPAPI on Windows. A public verification key in the desktop package is intentional;
the matching private signing key must never be packaged or published.
