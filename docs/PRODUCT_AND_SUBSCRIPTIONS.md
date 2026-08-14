# Drip Type by Zap — plans and entitlements

## Live plans

| Capability | Core — $9.99/month | Pro — $25/month |
| --- | --- | --- |
| Global Drip Composer | Included | Included |
| Natural typing engine and presets | Included | Included |
| Custom global shortcuts and hard stop | Included | Included |
| Local templates | Up to 50 | Up to 250 |
| Categorized starter template library | — | Included |
| CSV/TSV batch personalization | — | Up to 250 rows per run |
| Reusable local writing profiles | — | Up to 20 |
| Private searchable clipboard workspace | — | Up to 200 explicit captures |
| On-device Writing Lab transforms | — | Tighten, direct, warm, outline |
| Signed automatic updates | Included | Included |

Both plans are sold through Stripe-hosted Checkout and managed through Stripe’s
Customer Portal. Core includes a 14-day local trial. Pro is an advanced local
workflow plan; it does not promise remote AI, voice, sync, or automatic
clipboard monitoring.

## Privacy boundaries

- Composer drafts remain in memory and are not persisted automatically.
- Templates, profiles, and explicitly captured clipboard items are stored on
  the user’s Mac.
- Clipboard history is never monitored automatically. A user must press
  **Capture clipboard** for an item to enter the workspace.
- Batch rows and Writing Lab text are processed deterministically on-device.
- No third-party AI writing API receives Core or Pro writing content.
- Billing requests contain subscription, plan, and device-bound activation
  data, not writing content.

## Entitlement architecture

The app never decides paid access from an editable local plan flag.

1. Stripe Checkout creates a recurring Core or Pro subscription.
2. The Vercel billing service verifies the live Stripe session and subscription
   price before identifying the plan.
3. The service issues a short-lived Ed25519-signed entitlement containing the
   plan, bounded feature list, hashed device binding, issue time, and expiry.
4. Electron verifies the signature and every claim in the main process using an
   embedded public key.
5. Pro IPC handlers separately require their specific signed feature claim.
   Hiding a renderer control is never the security boundary.
6. The refresh credential is stored in macOS Keychain. Authoritative 401, 402,
   and 403 responses revoke local paid access.
7. Customers can activate up to three Macs and manage renewals, payment methods,
   invoices, plan changes, and cancellation in Stripe’s Customer Portal.

## Pro feature claims

The Pro entitlement includes:

`composer`, `typing`, `hotkeys`, `templates`, `updates`, `profiles`,
`clipboard`, `template_library`, `batch`, and `writing_lab`.

Core entitlements and the Core trial do not include the final five Pro-only
claims. Core composing remains functional when every Pro feature is absent.
