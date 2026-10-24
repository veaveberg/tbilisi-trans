# Pixel stop board

`StreetScreenController` owns the original overlay UI, preferences, language/status intervals, weather and the arrivals-panel observer. It passes current state to `PixelBoard`; it no longer renders browser text.

`PixelBoard` owns the canvas, full-width device-resolution sizing with physical-pixel LED centers, visibility lifecycle and animation loop. `BoardRasterizer` converts arrival state into a brightness grid and per-cell tints using the bundled bitmap faces. `WebGLDisplay` applies time-based fade, fixed LED apertures and bloom. Scroll positions snap to LED cells and raster targets are binary. Only the display owns brightness interpolation, so the 5 ms fade half-lives are independent of scroll speed. A lost/unavailable WebGL context switches to `CanvasDisplay`, preserving the same grid and arrival updates.

The renderer contains no demo arrivals or network fetching. Existing board URLs, the app's schedule/realtime data selection and destination filters still feed the same controller. The `wgy` palette colors urgent arrivals green and the right status yellow. Orange is the default for new preferences; existing saved palette choices remain honored.

## Bitmap font regeneration

The source fonts are `src/assets/fonts/5x7-matrix.otf` and `public/fonts/MatrixSansPrint-Regular.ttf`. Their outline-cell extraction is deterministic:

```sh
swift -module-cache-path /tmp/ttc-font-cache prototypes/led-board/export-board-fonts.swift
```

This writes both the production `src/assets/fonts/board-pixels.json` and the prototype copy. The source fingerprints are embedded in the JSON and checked by tests. Original font rights remain those of the source files. The afterimage shader evolved from Three.js r180; retain `THREE-LICENSE.txt` with redistribution.

## Checks

```sh
npm run test:pixel-board
npm run build
```

The pure test renders the actual production rasterizer using the bundled fonts. It covers minute changes, layout capacity, full-width sizing, stop changes, empty state, palettes and fading, including identical fade curves for slightly overflowing and long names. For browser integration, open `/scripts/fixtures/pixel-board.html` on the Vite development server and select Run integration checks. The fixture mounts the real overlay and controller, changes arrivals through DOM attributes, exercises the original controls, checks lifecycle/loading, and deliberately loses WebGL to verify continued updates through Canvas2D. It is not a production build entry.
