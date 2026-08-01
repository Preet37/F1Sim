# Third-party assets

Everything in this repository is either written for it or listed below. There
are no Formula One trademarks, no real team names, no real driver names and no
sponsor marks anywhere in the project — every team, engine, driver and livery is
fictional, and that is a deliberate constraint rather than an oversight.

## Fonts

### Archivo (variable, width + weight axes)

- **Files:** `src/ui/fonts/archivo-latin.woff2`, `src/ui/fonts/archivo-latin-ext.woff2`
- **Designers:** Omnibus-Type (Pablo Cosgaya, Héctor Gatti, Andrés Torresi)
- **Source:** Google Fonts — <https://fonts.google.com/specimen/Archivo>
  (subset `woff2` files as served by `fonts.gstatic.com` for
  `family=Archivo:wdth,wght@62..125,100..900`, Archivo v25)
- **Licence:** SIL Open Font License 1.1 — <https://openfontlicense.org/>
- **Upstream repository and full licence text:**
  <https://github.com/Omnibus-Type/Archivo/blob/master/OFL.txt>
- **Modifications:** none. The files are the unmodified Latin and Latin-Extended
  subsets as published; only the `@font-face` declaration is ours.

Archivo is used for display type — screen titles, team names, driver names,
buttons — at the wide end of its width axis. It is *not* used for figures:
every lap time, delta, percentage and race number stays in the system monospace
stack, which is downloaded from nowhere.

## Everything else

No image files. Every other graphic in the game is generated at runtime:

- Circuit outlines are traced from the same surveyed spline the physics drives on
  (`src/ui/CircuitArt.ts`, `src/data/tracks/`).
- Liveries, tyre sidewalls, trackside signage and the studio backdrop are drawn
  into a `<canvas>` and uploaded as textures (`src/render/Livery.ts`,
  `src/render/TyreTexture.ts`, `src/render/CarStage.ts`).
- The car in the showcase is the same mesh the race renders, lofted from
  section curves in code (`src/render/CarMesh.ts`).
