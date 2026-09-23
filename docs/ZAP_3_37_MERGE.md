# Zap 3.37.4 source integration

The user-supplied `zap-releases-3.37.4` source was inspected read-only and its
regular interface features were adapted into the existing Zap desktop project.
This is a selective integration, not a replacement of the application runtime.
The downloaded source directory was not changed or executed.

## Combined behavior

| Source capability | Combined app |
| --- | --- |
| Answer, simple answer, translation, summaries, explanation, problem solving, code, research | Existing Zap AI tools retained with account-authenticated server requests; research remains a knowledge-based brief without live search. |
| Multi-capture, region selection, pinned answers, follow-up prompts | Existing preview/crop, four local attachments, pinned plain-text window, and context handoff retained. Captures upload only on submission. |
| Form/autopilot output | Reviewable form drafts retained; automatic browser clicking/submission is not imported. |
| Drip Type | Existing typing engine, cancellation, permission checks, and Option/Alt+5 retained. |
| Formatted AI responses (`overlay.html`, `fmtMd`) | Headings, lists, emphasis, inline code, and code blocks adapted in `src/zap-content.js`. DOM text nodes replace HTML string rendering. Copy, pin, and typing receive the original response. |
| Flashcards (`flashcards.html`) | Expanded study dialog, keyboard navigation, shuffle, clickable card positions, and numbered Q/A compatibility added through `src/zap-study.js` and `src/zap-content.js`. Existing JSON cards still work. |
| Translation picker (`settings.html`) | The 35 language choices added to AI settings; custom names still accepted. |
| Authentication, subscriptions, support, updates | Current secure browser login, server-side billing, support website, and signed update flow retained. Source-local password checking, embedded credential paths, and alternate update logic are not imported. |
| Appearance | Current Zap branding, light/dark/system styles retained. Legacy overlay opacity, ghost styling, and skin sliders are not imported. |

The study dialog expands within the app window; this import does not add a
separate native fullscreen shortcut. Escape closes it and restores focus.
Study decks and history remain in memory and are cleared on sign-out, history
clear, or quitting. Closing the main window keeps the app running as before.

## Excluded components

Process concealment, kernel drivers/DLL injection, security-software bypasses,
anti-termination persistence, self-deletion, and stealth/lockdown routines are
not part of this merge. The supplied launcher, kernel, helper, and bot code is
not copied into the product or source download. The four previously removed
workspaces remain removed.

No provider credentials are imported. No database or SQL query path is added.
AI still uses the existing authenticated, bounded, rate-limited server endpoint.
Do not place a provider secret in desktop files. Hosted AI requires a configured
server credential; no live inference was performed for this integration.

The old renderer's blanket LaTeX replacement is not copied: it can change code,
currency, and mathematical expressions. Code-block contents and raw response
text are preserved.

## Verification

- `npm run verify`: syntax checks, source/API security tests, and bundle build.
- `npm run test:desktop`: isolated Electron fixture with real bundled UI and
  preload; no production credentials, payments, screen captures, or typing.
- Study checks: flip, arrow navigation, boundaries, shuffle reset, direct card
  navigation, legacy Q/A cards, strict size/count limits, and copied deck data.
- Formatting checks: headings/lists/emphasis/code; embedded scripts, image event
  handlers, and JavaScript links produce no active markup.
- Account sign-out and history clearing continue to clear private UI state.
- A Windows path normalization fix in the credential scanner prevents its known
  nonfunctional test placeholder from falsely failing Windows CI, while keeping
  the same value detectable in production files.

This source integration has not been deployed or published as a new installer.
The project's version remains 1.8.0 until a release is prepared. The 3.37.4 label
identifies the imported reference source, not a newly published app version.

## Run the combined source

Extract `Zap-combined-source.zip`, enter its `Zap-combined` directory, and use
Node.js 22 or newer:

```sh
npm ci
npm run verify
npm start
```

`npm start` now builds and loads the bundled app so sandboxed renderers do not
try to execute unbundled CommonJS imports.

For an isolated UI preview with simulated account/AI data:

```sh
npm run preview:desktop
```

The download contains current application, website/backend, tests, build scripts,
assets, and documentation. It omits local data, dependencies, generated installers,
Git history, deployment credentials, and the original bypass components.
