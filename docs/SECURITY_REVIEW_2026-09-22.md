# Injection and credential review — September 22, 2026

## Scope and conclusion

Reviewed the current desktop source, website/API handlers, account and support
storage, Stripe request construction, reachable Git history, generated bundles,
the actual published Zap 1.8.0 Mac archive, and 30 public website text assets.

No application SQL driver, SQL query execution, or interpolated SQL statement was
found in the reviewed application paths. Accounts/support use encrypted private
Blob objects; billing uses Stripe's API. No hardcoded operational API credential
was detected by the expanded pattern scan. These findings are bounded by the
reviewed source and tests; they are not a guarantee that every vulnerability or
arbitrarily encoded secret is absent.

## Findings addressed

1. **Low — scalar input coercion.** Some identifier/email validators converted
   arrays to strings. They now require strings before validation. Regression
   tests cover arrays, objects, SQL-like suffixes, path traversal, and appended
   query parameters.
2. **Low — inherited metadata names.** Billing metadata validation could inspect
   properties inherited from Object.prototype. Its allowlist now checks own
   properties. Tests reject `constructor`, `__proto__`, and `toString` before any
   storage/network request. This was an internal helper, not a demonstrated
   unauthenticated account takeover or SQL injection.
3. **Coverage gap — secret scanning.** Quoted JSON/configuration keys and several
   server credential names were not covered by the generic assignment detector.
   Added those forms and regression tests. Output contains only locations and
   fingerprints. One exact, nonfunctional OIDC test placeholder is exempted only
   in its existing test file, including that file's history; the same value in a
   production file is still reported.

## Controls verified

- Stripe uses fixed service endpoints, encoded URLSearchParams, and validated
  identifiers. A test with SQL syntax and injected query delimiters remains a
  single email value and cannot change the endpoint, customer, or limit.
- Account paths use HMAC-derived IDs; raw email input never becomes a storage path.
- Passwords use scrypt; private account/support records use authenticated encryption.
- Exact request-key checks, origin checks, bounded bodies, shared rate limiting,
  and authenticated AI access remain enabled.
- API credentials come from server environment variables. Fixed public service
  URLs and the public entitlement verification key are intentional, not secrets.

## Verification

- `npm run verify`: passed, including the new injection/credential regression tests.
- Expanded source/generated/history pattern scan: no findings.
- Published Mac ZIP: SHA-256 matched the immutable release checksum before ASAR
  extraction; expanded package scan returned no findings. The app was not executed.
- Live website: 30 text assets scanned, no findings.
- Windows 1.8.0 release CI previously passed packaged credential scanning; its
  installer was not re-extracted in this follow-up review.

## Remaining operator action and limits

Rotate/revoke the NVIDIA key previously shared in chat and the credential embedded
in the separate original Zap Pro installation. This review did not modify that
installed app or verify provider-side revocation. Never copy those credentials
into the new app. Hosted AI still requires a rotated sensitive server-only key.

The scanner excludes dependencies, local training environments, large files over
its documented limit, and arbitrary encodings. SQL added in future must use
parameterized queries; the present absence of SQL does not prove future code safe.
Public service URLs remain fixed to constrain where authenticated requests go.
