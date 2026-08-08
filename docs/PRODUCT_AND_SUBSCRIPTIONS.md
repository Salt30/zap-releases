# Drip Type product and subscription plan

## Positioning

Drip Type should grow from a natural typing utility into a system-wide writing
and workflow layer for macOS. The product promise is: capture, improve, reuse,
and enter text in any app without breaking focus.

The $24.99 plan should not be a collection of cosmetic extras. It should save a
user time in at least three daily workflows: composing, reusing, and automating
text.

## Recommended packages

| Capability | Core — $9.99/month | Pro — $24.99/month |
| --- | --- | --- |
| Global Drip Composer | Included | Included |
| Natural typing engine and behavior presets | Included | Included |
| Custom global shortcuts and stop control | Included | Included |
| Local saved snippets | Up to 25 | Unlimited |
| Per-app typing profiles | 3 profiles | Unlimited |
| AI rewrite actions | — | Rewrite, shorten, expand, tone, reply, summarize, translate |
| Smart templates | — | Variables, fill-in fields, dates, conditional sections, calculations |
| Voice-to-composer | — | Included |
| Private clipboard history | — | Encrypted history with search and retention controls |
| Workflow actions | — | Chained transformations, templates, and destination profiles |
| Sync | — | End-to-end encrypted sync across Macs |
| AI allowance | — | Defined monthly fair-use allowance with visible usage |

Core should remain useful offline after a successful entitlement refresh. Pro
network features should fail gracefully without preventing local composing or
access to the user's local data.

## Pro feature priorities

1. **AI writing actions from any app.** Capture selected text or use the
   composer, then polish, shorten, expand, change tone, translate, summarize, or
   draft a reply before returning the result to the original app.
2. **Smart snippets and forms.** Reusable text with variables such as name,
   date, clipboard content, dropdowns, optional sections, and tab-through
   fields. This makes Drip Type useful for support, sales, recruiting, school,
   and operations.
3. **Voice-to-composer.** Dictate into the same translucent interface, edit the
   transcript, and drip it into any application.
4. **Private clipboard workspace.** Searchable text history, pinning, favorites,
   automatic expiration, and an exclusion list for password managers and
   sensitive apps.
5. **Per-app workflows.** Different tone, typing behavior, snippets, and default
   actions for Mail, Messages, browsers, CRMs, and document editors.
6. **Encrypted sync.** Sync snippets, profiles, and preferences across a user's
   Macs without giving the service readable access to their content.

The first Pro release should ship priorities 1–3. Clipboard history, workflows,
and sync should follow after the core entitlement and data-security systems are
stable.

## Secure subscription architecture

The app must never decide paid access from an editable local boolean.

1. Use hosted Stripe Checkout for purchases and Stripe Customer Portal for
   billing changes. Card details never enter the desktop app.
2. Process subscription webhooks on a server and verify every Stripe webhook
   signature before changing access.
3. Maintain server-side entitlements such as `core.composer`, `core.snippets`,
   `pro.ai`, `pro.templates`, `pro.voice`, and `pro.sync`.
4. After account authentication, issue a short-lived, signed entitlement token
   containing user ID, tier, features, device ID, issued time, and expiration.
5. Verify that token in Electron's main process with an embedded public key.
   Renderer windows receive only the specific capabilities they need.
6. Store refresh credentials in macOS Keychain, never in `electron-store`,
   renderer storage, logs, or crash reports.
7. Enforce AI quotas, rate limits, and subscription state on the server. Local
   feature checks improve UX but are not the source of truth.
8. Allow a short offline grace period for previously verified users, then
   require a refresh. Revoked, refunded, or expired accounts lose paid
   entitlements on the next refresh.
9. Bind sessions to a small device allowance and give users a self-service page
   to remove old devices.
10. Keep Core composing functional when remote AI or billing services are
    unavailable.

No desktop subscription gate is impossible to bypass. Signed, short-lived
entitlements plus server-side enforcement make bypassing the valuable network
features impractical and keep billing state authoritative.

## Delivery order

1. Finish and release Drip Composer as the local Core foundation.
2. Add account authentication, Keychain storage, checkout, webhook processing,
   signed entitlements, trial handling, and account management.
3. Add local snippets and profiles to make Core justify its monthly price.
4. Build Pro AI actions, smart templates, and voice composition.
5. Add encrypted clipboard history, workflow chaining, and sync.
6. Add privacy-preserving product analytics for activation, retention, failures,
   and feature usage; never record composed text.

## Market context

- Text Blaze currently offers snippets, forms, dynamic rules, and shared
  templates at materially lower prices, so Core cannot rely on text expansion
  alone: <https://blaze.today/plans/>.
- Raycast Pro starts at $8/month and combines AI, sync, clipboard history,
  translation, notes, and customization. A $24.99 Drip Type Pro plan therefore
  needs a focused system-wide writing workflow and a meaningful AI allowance:
  <https://www.raycast.com/pro>.
- Stripe supports hosted subscription checkout, customer self-service, and
  feature entitlements; billing events should still be mirrored into the app's
  own signed entitlement service: <https://stripe.com/docs/billing>.
