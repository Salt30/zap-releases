# Drip Type

A standalone Electron app that types text into the active macOS application with configurable human-like timing.

## Features

- Configurable words per minute and start delay
- Per-character Gaussian speed variation
- Optional mid-sentence thinking pauses
- Brief speed bursts
- Nearby-key typos followed by automatic correction
- Extra pauses around punctuation
- Markdown cleanup before typing
- Global stop shortcut
- Safe clipboard fallback outside macOS

## Requirements

- macOS for automatic typing
- Node.js 18 or newer
- Accessibility permission for Electron or the packaged app

## Run locally

```bash
npm install
npm start
```

On first launch, enable access under **System Settings → Privacy & Security → Accessibility**.

## Controls

1. Enter or paste text.
2. Choose the typing behavior.
3. Press **Save settings**.
4. Press **Start typing**.
5. During the start delay, focus the destination text field.

The default stop shortcut is `Option+0` (`Alt+0` in Electron accelerator syntax).

## Platform behavior

The automatic engine uses macOS System Events through `osascript`. On Windows and Linux, the current version copies the cleaned text to the clipboard instead.

## Responsible use

Use automation only in applications and workflows where you have permission. Do not use it to impersonate another person or evade rules, monitoring, or assessment requirements.

## License

MIT
