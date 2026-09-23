# Zap integration

Zap Pro 3.35.2 was inspected for workflow compatibility. This implementation uses
Zap's existing sandbox, trusted IPC, account credentials, typing engine,
appearance, and build pipeline. The installed Zap application is not modified.

## Server-provided AI

The desktop posts to `https://tryzap.net/api/zap-ai`, routed through the existing
account API without adding another serverless function. The server validates the
existing device-bound refresh credential against Stripe before accepting a
request. A private Blob record per subscription atomically enforces 100 requests
per UTC day across server instances. Records contain only a date and count under
a hashed subscription identifier. Failed provider attempts count toward the limit.
Shared counters also enforce 10 requests per subscription per minute, 20 per IP
per minute, and a 10,000-request service ceiling per UTC day. All counters fail
closed when storage is unavailable. HMAC identifiers replace raw IP addresses.

The desktop never receives a provider key. Set `NVIDIA_API_KEY` as a sensitive
server-only variable on the existing Vercel project. Do not use a public prefix,
commit it, place it in a desktop environment file, or include it in app assets.
The secret must be configured and the server deployed before the desktop's live
AI request path is available.

`NVIDIA_TEXT_MODEL` and `NVIDIA_VISION_MODEL` optionally override server models.
Text defaults to `meta/llama-3.3-70b-instruct`; vision defaults to
`meta/llama-3.2-11b-vision-instruct`. Llama 3.2 image requests place application
instructions in the user message because that model rejects system messages
with images. These updated paths are covered by simulated provider tests;
authenticated live inference still requires deployment verification. Four user-selected regions are combined locally into
one numbered image, because the hosted vision model takes a single image.

The API uses NVIDIA's documented OpenAI-compatible endpoint:
[model endpoint and image request format](https://build.nvidia.com/meta/llama-3.2-11b-vision-instruct).
NVIDIA describes hosted free access as prototyping/trial access, subject to its
limits; this integration makes no promise of unlimited or permanently free AI.

Research produces a brief from user material and model knowledge. It has no live
web search and must not fabricate citations or claim that its facts are current.

## Boundaries

- Model endpoint and credentials are server-controlled; clients cannot choose URLs.
- Provider request timeout: 50 seconds. Desktop timeout: 90 seconds.
- One concurrent request per desktop instance, with explicit cancellation.
- Request limit: 3 MiB, with a combined image under 2.5 MB of base64 data.
- Text limit: 100,000 characters; context limit: 4,000; response cap: 4,096 tokens.
- Provider response limit: 2 MiB; redirects are rejected.
- No request bodies, response bodies, credentials, or images are logged.
- Output is inserted as text, never evaluated as HTML or code.
- Screenshots and responses are retained only in window memory unless the user
  explicitly copies or transfers the text to Drip Type or another application.
- Pinning keeps text in a separate floating window until that window is closed.

## Files and verification

`src/zap-ai.js` is the desktop service client. `src/zap-main.js` manages capture,
IPC, shortcuts, cancellation, and pinned answers. `src/zap-ui.js` implements the
workspace and crop/study workflows. `website/server/zap-service.js` authenticates
requests, `zap-quota.js` reserves usage, and `zap-model.js` talks to NVIDIA.

Run `npm run test:zap`, `npm run test:desktop`, and `npm run verify`.
Unit tests simulate providers, subscription state, concurrent quota reservations,
and runtime IPC. The desktop fixture uses simulated captures and AI responses;
it never types into other apps, reads production credentials, or captures screens.
Live NVIDIA tests use only generic prompts and a generated solid-color image.
Native Screen Recording prompts and final signed packages still require device
verification. An API key pasted into a chat should be rotated before a public
release; replace only the server variable when rotating it.

The website and backend security updates were deployed to https://tryzap.net on
2026-09-15. Public assets are allowlisted; backend source is excluded. The four
retired workspaces have been removed from the new desktop build, and only Core
is offered for new purchases. Existing Pro subscriptions remain manageable.

The Apple Silicon preview is unsigned and has not replaced the published desktop
release. Production AI still needs a rotated NVIDIA credential configured on the
server. Automatic approval review rejected the earlier credential upload; it was
not retried during the security audit. No provider key belongs in a desktop build.

## September 22 reliability and interface update

The desktop now distinguishes known provider configuration, busy, and request
failures without exposing raw provider responses. It shows an active request
state, preserves the prompt for retry, and scrolls completed answers into view.
The liquid glass interface supports light/dark themes, reduced motion, reduced
transparency, and high contrast using the existing Electron renderer.

Deploy the backend changes and configure a valid rotated `NVIDIA_API_KEY` in
the hosting dashboard, then rebuild/distribute the desktop. Verify a text-only
question and a screenshot-only question using a connected subscribed account.
No production secrets were read or changed during this update.
