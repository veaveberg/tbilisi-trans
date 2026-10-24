# LED board prototype

Run from the repository root:

```sh
python3 -m http.server 8794 --bind 127.0.0.1 --directory prototypes/led-board
```

Open http://127.0.0.1:8794. This standalone prototype uses sample arrivals. The production stop board now uses the pixel renderer in `src/pixel-board`, connected through `src/street-screen.js` to the actual arrivals panel and original fullscreen controls.

## Original typefaces, fixed bitmap cells

`assets/original-board-fonts.json` contains bitmap glyphs extracted from the exact typefaces in the original board:

- `src/assets/fonts/5x7-matrix.otf`, rendered at 14 CSS pixels in the source, supplies Latin text and numbers. Each normal character advances six LED cells.
- `public/fonts/MatrixSansPrint-Regular.ttf`, the TTF version of Matrix Sans Print used by the app, rendered at 20 CSS pixels, supplies Georgian and symbols. Georgian labels use uppercase Mtavruli, matching `normalizeLedLabel` in `src/street-screen.js`.

The fonts contain grid-aligned outlines. The exporter uses CoreText only to read the outline geometry and advance widths. It tests whether each intended LED cell center is inside a filled outline. No browser font rasterizer, antialiasing, or installed font fallback participates in generation or runtime display. Original glyph offsets, descenders, case, and advances are retained. Bitmap data includes source SHA-256 hashes and PostScript names.

Regenerate on macOS from the repository root:

```sh
swift -module-cache-path /tmp/ttc-font-cache prototypes/led-board/export-board-fonts.swift
```

The export is deterministic. The generated JSON is bundled; running the board does not require Swift or the original font files. Existing font rights remain those of the original assets. Earlier downloaded font experiments remain on disk but are no longer loaded.

## Settings

The approved defaults live in `board-content.js` and initialize the controls:

| Setting | Default |
| --- | --- |
| LED diameter | 0.9 |
| Glow | 0.15 |
| Fade-in half-life | 5 ms |
| Fade-out half-life | 5 ms |
| Scroll speed | 14 LED cells/s |
| Unlit LEDs | 0.08 |
| LED color | #ff6633 |

Restore defaults resets these values. Clean LEDs disables glow and fading for comparison.

## Mechanics copied from the source

The geometry is 152 × 72 LED cells, equivalent to the original 304 × 144 CSS-pixel board with two-pixel LED pitch. Arrival rows start at 0/9/18/27/36/45, the ticker starts at 56, and the footer at 65. Horizontal columns are 18 + 2 + 118 + 2 + 12 cells.

- Six main arrivals with continuous overflow ticker. Exactly seven arrivals use seven static rows and hide the ticker.
- Long destination names wait two seconds, pan to their end, wait two seconds, then reset. They use bitmap advance widths to determine overflow. Smooth brightness coverage and the approved speed replace the source's discrete CSS steps.
- Automatic Georgian/English changes every ten seconds. Case is preserved in Latin labels. Georgian labels use Mtavruli. Language can also be pinned manually.
- The footer alternates temperature and current Tbilisi time every ten seconds. Clock colon blinks; SMS text appears for Tbilisi.
- Live arrivals at one minute or less blink with the source's 400 ms cycle. The sample update button subtracts a minute so this and the original 320 ms vertical number transition can be inspected.
- Empty arrivals show a centered Tbilisi clock with seconds and temperature at the bottom right.
- Fill height computes row capacity from the available height and retains fixed-width LED geometry.
- Pause freezes display time. Rendering suspends while the document is hidden, and reduced motion starts paused.

The custom WebGL display uses two alternating 16-bit packed history buffers for time-based attack/release. Bitmap coverage interpolates between fixed LEDs during movement. Two low-resolution Gaussian passes produce bloom outside the LED mask, then the sharp mask and bloom are composited. The persistence shader evolved from Three.js r180 AfterimageShader; its MIT notice is in `assets/THREE-LICENSE.txt`. No Three.js runtime is bundled.

## Verification

```sh
node prototypes/led-board/verify-board.mjs
node prototypes/led-board/verify-motion.mjs
node --check prototypes/led-board/studio.js
```

Checks cover source hashes, Latin/Georgian glyph coverage, integer advances, approved settings, 6/7/overflow capacity, name-scroll timing, vertical number offsets, fractional coverage, and time-based fading at 30/60/120 Hz. Browser checks cover the real bitmap render and scenario controls. Performance on an iPhone, live-arrival integration, weather fetching, and graphics-context restoration still require integration work.
