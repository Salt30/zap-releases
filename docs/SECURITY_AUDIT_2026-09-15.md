# Zap security audit — September 15, 2026

## Outcome

Templates, Pro Studio, Profiles, and the saved Clipboard workspace are removed
from the new desktop UI, preload API, and privileged IPC handlers. Zap AI and
Drip Type remain, with Option+5 / Alt+5 opening Drip Type. Existing saved data is
preserved. New purchases offer Core; existing Pro subscriptions remain manageable.

The website metadata and backend security fixes are deployed to
[tryzap.net](https://tryzap.net). The new desktop build is an unsigned Apple Silicon
preview at `dist/zap-preview/mac-arm64/Zap.app`; the public desktop downloads have
not been replaced. This audit found and fixed concrete issues, but does not certify
that every possible vulnerability or credential exposure has been eliminated.

## Scope

- Desktop main process, renderer, preload, IPC senders, permissions, navigation,
  account credential storage, AI requests, build inclusion rules and Electron fuses.
- Website output, metadata, headers, account sessions, passwords and recovery,
  admin authorization, support storage, checkout, activation, entitlement refresh,
  Stripe webhook verification, and AI authentication and quotas.
- Dependency advisories for desktop/build and website packages.
- Redacted credential-pattern scans across source, generated website/desktop
  assets, ASAR application files, and reachable Git history (137 commits).
- Bounded production checks using public pages and invalid requests. No customer
  purchases, messages, password resets, or real-account login attempts were made.

## Findings addressed

| Finding | Resolution and evidence |
| --- | --- |
| Backend source publicly served | Before deployment, `/server/accounts.js` returned 200 with backend JavaScript. The website now publishes an explicit allowlist of 36 static assets. That path, other checked server paths, `/.env`, and `/package.json` return 404. No literal key was found in the checked exposed response. |
| Request limits local to one server instance | Added shared, conditional-write counters in private Blob storage. Authentication, checkout, support, billing and AI limits survive independent instances. Unavailable storage or exhausted concurrency retries reject the request. |
| Environment whitespace broke the new limiter | Normalized the master key exactly as account encryption already does. Added a regression test; repeated live account-config requests return 200. |
| Vulnerable `js-yaml` dependency | Updated 4.3.1 to 4.3.2, addressing the high-severity CPU exhaustion advisory. Both fresh dependency audits report zero known vulnerabilities. The packaged app contains 4.3.2. |
| Support form missed provider-key patterns | Added NVIDIA, OpenAI/Anthropic and Groq detection across submitted text fields, in addition to the existing sensitive-data checks. These checks reject recognizable credentials; they cannot identify every arbitrary secret. |
| IPC sender validation could be more precise | Require the exact trusted main frame, app scheme, host and root page path. Reject subframes, missing frames, nested paths, credentials in URLs and unexpected ports. |
| Weak minimum for new passwords | Increased signup/reset minimum to 12 characters and bounded authentication input before hashing. Existing users can still sign in with their old passwords. |
| Raw storage errors could reach logs | Replaced account/support storage exception details with fixed operation codes. Provider requests and responses are not logged. |
| Retired feature endpoints remained an unnecessary surface | Removed their renderer calls, preload methods and privileged handlers. Standalone training utilities remain outside the desktop bundle. |

The dependency finding is documented in
[GHSA-2883-xcg3-v3hh](https://github.com/advisories/GHSA-2883-xcg3-v3hh).

## Request and usage limits

| Operation | Shared limit |
| --- | --- |
| Register, sign in, recover, sign out | 10 requests per IP per minute, shared across these actions |
| Checkout creation | 5 requests per IP per 10 minutes |
| Support submission | 5 requests per IP per 10 minutes |
| General billing mutations | 30 requests per IP per minute |
| Account configuration | 60 requests per IP per minute |
| Account / checkout status | 30 requests per IP per minute per policy |
| Admin statistics / tickets | 10 / 20 requests per IP per minute |
| AI request entry | 20 requests per IP per minute |
| Authenticated AI usage | 10 requests per subscription per minute; 100 per UTC day |
| Total AI service usage | 10,000 requests per UTC day |

Minute limits use fixed windows. IP counters are HMAC identifiers, not plaintext
addresses; each policy has at most 256 shards, each capped at 64 entries and 16 KB.
Daily reservations are consumed before inference, so failed or cancelled requests
can count. Provider quotas can impose additional restrictions. Rate-limited
responses use 429 and `Retry-After`; protection/storage failures use 503.

The production test initially appeared to exceed the IP limit. Temporary keyed
counter diagnostics established that the test runner used three distinct outbound
addresses; their counts advanced independently. A subsequent bounded test reached
429 with `Retry-After: 54` after 21 requests in about 6.6 seconds, despite rotating
caller-supplied `x-forwarded-for` values. Temporary diagnostic logging was removed.
Vercel's address-header trust boundary follows its
[request-header documentation](https://vercel.com/docs/headers/request-headers).

IP limits do not replace edge protection against distributed denial of service.
Heavy contention or a full shard intentionally rejects work and can affect
availability. Edge/WAF policy, hosting spend controls and external alert delivery
were not comprehensively tested or changed.

## Credential findings and required follow-up

1. **Rotate the NVIDIA key pasted in the conversation.** It is outside the clean
   repository/package scan and should be treated as exposed. A temporary local
   file holding that key was removed. No provider key was added to the desktop.
2. **Revoke the embedded provider credential in the original Zap Pro app.** The
   separate installed `/Applications/Zap Pro.app` contains a recognizable provider
   key in its ASAR main script. Its validity was not tested. That installed app
   was not modified or imported into the new package.
3. **Configure the rotated NVIDIA key as a sensitive server-only Vercel variable.**
   Hosted AI remains unavailable until this is done. Earlier automatic approval
   review rejected the credential upload; this audit did not retry that upload.
4. **Publish a new signed desktop release** to deliver these changes to existing
   users. The current preview is unsigned; existing release artifacts are unchanged.

The final project/package/history pattern scan found **zero matches** across 893
scanned items, including this report. It excludes dependency trees, local
training environments, Vercel CLI state, files above 8 MB, unreachable Git objects,
and binary installer containers other than inspected ASAR files. Pattern-based
scanning cannot prove that an arbitrary or obfuscated secret is absent. Public
entitlement verification keys are intentional; private signing keys must remain
server-side. CI now scans source, reachable history and the packaged app, and
release workflows scan application artifacts before publication.

## Existing controls confirmed

- Sandboxed renderers, context isolation, constrained preload APIs, trusted IPC,
  Content Security Policy, safe text rendering and hardened Electron fuses.
- Provider credentials and model endpoints controlled by the server; clients
  cannot supply a provider URL or model. Redirects are rejected. Request/response
  sizes, token output and runtime are bounded, with cancellation support.
- Active Stripe subscription and device-bound credential verification before
  inference; signed entitlements and platform-protected desktop refresh credentials.
- Encrypted private account/support storage, scrypt password hashing, secure
  HttpOnly session cookies, mutation origin checks, account lockout, and
  concurrency-tested recovery/activation/checkout handling.
- Admin authorization requires both configured email and account-ID allowlists.
  Stripe webhooks verify signatures and timestamps before processing events.

## SEO, AEO and metadata

- Zap titles, descriptions, canonical URLs, Open Graph and Twitter metadata across
  public pages; current product features and one Core offer in the homepage schema.
- Organization, WebSite, SoftwareApplication and FAQPage structured data. Eight
  visible FAQ answers match the structured answers, including shortcuts, AI data
  handling, access requirements, usage limits, platform permissions and pricing.
- Removed retired-feature sales claims and updated privacy/terms to describe
  legacy data preservation. Account, admin, success and API paths carry noindex
  headers; public sitemap and robots directives are updated.
- Updated the CSP hash for the structured-data script and verified internal assets.

Clear visible answers and conventional technical SEO follow
[Google's AI optimization guidance](https://developers.google.com/search/docs/fundamentals/ai-optimization-guide).
No search ranking, indexing, rich result or AI citation is guaranteed. Search
Console indexing and third-party answer-engine results were not verified.

## Validation

- `npm run verify`: passed, including security boundaries, concurrent counters,
  quotas, checkout races, recovery races, API authorization, SEO and static output.
- Desktop fixture: passed across six remaining pages, light/dark and compact
  layouts, capture/crop, flashcards, cancellation, safe response rendering,
  Drip Type handoff, shortcut handling and saved-data preservation.
- `npm run verify:package -- dist/zap-preview/mac-arm64/Zap.app`: passed.
- Root and website `npm audit`: zero known vulnerabilities at audit time.
- Redacted secret scan and `git diff --check`: passed. CI/release YAML parses.
- Live homepage, robots and sitemap: 200. Backend/config files: 404. Account/admin
  authenticated APIs: 401 without a session. Repeated account config: 200.
- Runtime error-log query for the verified deployment returned no error rows in
  the checked window. This is a point-in-time check, not continuous monitoring.

Windows native behavior, signed universal Mac notarization, actual customer
checkout/payment completion, live inference with the rotated server credential,
provider account revocation and independent penetration testing remain outside
the completed verification.

## Deployment record

Production website: https://tryzap.net

Framework: static HTML/CSS/JavaScript with Node 22 serverless functions.
Source: local changes on top of commit `a0bf7d1`; this is not a committed release.
The production backend-source exclusion, account protection and SEO changes were
published through Vercel and checked against the live domain.

- Final deployment: https://drip-type-fqfbfbv21-salt30s-projects.vercel.app
- Target/status: production / ready, aliased to `tryzap.net`.
- Final deployment duration: 23 seconds.
- Temporary limiter diagnostics: removed before final deployment.
- No monitoring integration or log drain was added; continuous alerts and drain
  configuration remain unverified.
