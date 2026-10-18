# Coleo app icon

A smooth coral-and-violet octopus on a pearl-lilac glass-style tile. The face and
vector treatment derive from `server/web-app/public/favicon.svg`; the palette,
raised arms, and silhouette derive from `docs/public/coleo-pet-v2.png`.

- `AppIcon.svg`: editable 1024 × 1024 vector master.
- `AppIcon.png`: full-resolution transparent preview.
- `AppIcon.icns`: native macOS icon with 16–1024 px representations.
- `AppIcon.icon`: appearance-aware Icon Composer document, with separate face,
  body, and arm layers, a dark background override, and system tint/clear rendering.

Regenerate after editing the SVG:

```sh
brew install librsvg # Provides rsvg-convert; only needed to regenerate artwork.
bash clients/macos/scripts/make-icon.sh
bash clients/macos/scripts/make-app.sh
```

`make-icon.sh` also extracts foreground SVGs into `AppIcon.icon/Assets` using
`scripts/icon-layers.py`. It omits the flattened tile, shadows, and highlights:
Icon Composer supplies the mask, background, and lighting. Groups in `icon.json`
are ordered front-to-back (face, body, arms).

The app bundler requires Xcode 26 or later and compiles `AppIcon.icon` with
`actool`, producing `Assets.car` and a compatibility ICNS in the bundle. It sets
both `CFBundleIconName` and `CFBundleIconFile`. Normal builds need no third-party
graphics tools. The root SVG/PNG/ICNS are flattened design previews; Tahoe uses
the compiled layered asset, not those previews.

Appearance follows System Settings → Appearance → Icon & widget style. Choose
Automatic to follow light/dark appearance, or select a tinted/clear style.
After rebuilding, quit and reopen the rebuilt app to avoid displaying the old
running application's cached icon.
