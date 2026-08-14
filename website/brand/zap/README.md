# Zap — Brand Kit v1.0

Everything you need to represent Zap consistently. Open **`Zap-Brand-Guidelines.html`**
in any browser for the full guide (logo, colour, type, voice).

## Contents

```
Zap Brand Kit/
├─ Zap-Brand-Guidelines.html     ← the guidelines document (start here)
├─ README.md
└─ assets/
   ├─ logo/
   │  ├─ zap-icon.svg             App icon — dark tile + gold-gradient bolt (512)
   │  ├─ zap-wordmark-dark.svg    Full lockup for dark backgrounds
   │  ├─ zap-wordmark-light.svg   Full lockup for light backgrounds
   │  ├─ zap-mark-mono-white.svg  Single-colour bolt (white)
   │  ├─ zap-mark-mono-black.svg  Single-colour bolt (black)
   │  ├─ zap-favicon.svg          32px favicon (matches tryzap.net)
   │  └─ png/                     Ready-to-use PNG icons: 64 / 128 / 256 / 512 / 1024
   ├─ social/
   │  └─ zap-og-card.png          1200×630 social / OG share card
   └─ tokens/
      ├─ zap-tokens.css           CSS custom properties
      └─ zap-tokens.json          Same values as JSON (for design tools / build steps)
```

## Quick reference

| Token | Hex | Use |
|---|---|---|
| Ink | `#08080E` | Page background |
| Surface | `#0F0F18` | Cards, panels |
| Tile | `#12122A` | Logo tile / icon chip |
| Gold | `#FFD24D` | Primary accent |
| Amber | `#F5A623` | Gradient dark stop |
| Electric | `#7AA2F7` | Secondary accent (sparingly) |

- **Signature gradient:** `linear-gradient(120deg, #FFE08A, #FFD24D 45%, #F5A623)`
- **Fonts:** Inter (UI + marketing), JetBrains Mono (code, keys, metadata)

## Notes

- The wordmark SVGs use live **Inter** text so they stay crisp — **outline the text**
  before print or before handing off to anyone without Inter installed.
- Colours match the tokens shipped on tryzap.net, so the site and brand kit stay in sync.
- Need raster (PNG) exports of the icon at 16–1024px? Open any SVG in Figma / Illustrator
  and export, or ask and they can be generated.

## Voice, in one line

Plain, precise, honest. Zap types **your own** words into any app, at your pace — describe
exactly that, and never claim it evades monitoring or proctoring.
