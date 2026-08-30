# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

WiFi Planner — a browser tool that estimates how a Wi-Fi signal propagates
through a floor plan. Live at `wifiplanner.handcraftingcodes.com`.

It is **plain static HTML/CSS/JS**: no build step, no bundler, no package
manager, no dependencies beyond two webfonts. The files in `website/` are
uploaded verbatim to S3. Do not introduce a toolchain without being asked.

```
website/          the whole app, served as-is
  index.html      markup + script load order
  app.js          geometry, RF solver, rendering, all UI wiring
  planimport.js   image → wall mask → rooms/doorways (pure, no DOM)
  importui.js     the import modal that drives planimport
  consent.js      cookie banner; gates Google Analytics
  styles.css      everything visual
  terms.html      terms of use
server-settings/  AWS hosting runbook
```

## Running and verifying

```bash
cd website && python3 -m http.server 8777      # then open http://localhost:8777
node --check app.js                            # syntax check; repeat per file
```

**There are no automated tests.** Verification is: `node --check` on every
changed `.js`, then drive the page in a real browser and read the console.
Most behaviour here is numeric (dBm values, coverage percentages, cell counts),
so the productive pattern is to evaluate JS in the page and diff the numbers
before and after a change — `solveResult = solveAll(6); computeStats();` runs a
solve synchronously and populates `roomStats` / `overallCov`.

Two things that will waste your time if you don't know them:

- **The browser caches aggressively over `http.server`.** After editing a file
  you will often get the old one. Force it:
  `await Promise.all([...files].map(f => fetch('/'+f, {cache:'reload'}))); location.reload();`
- **`recompute()` is `requestAnimationFrame`-based**, so in a backgrounded tab
  it never fires and the table/canvas stay stale. Taking a screenshot wakes the
  tab; calling `solveAll()` directly avoids the problem entirely.

## Architecture

### The raster contract

This is the one idea that makes the codebase tractable. `buildRaster(cell)` is
the **only** producer of solver input. Everything downstream — `attenField`,
`solveAP`, `computeStats`, `drawFloor`, the best-spot search — consumes only:

```js
R = { cell, nx, ny, nz, nxy, n, kind, opIdx, roomIdx, isExt, slabOpen }
kind:  0 = outside   1 = room   2 = wall   3 = opening
```

Indices are `f*nxy + j*nx + i`, and the grid extends `MARGIN` cm of outdoors
beyond the plan on every side because signal genuinely travels around the
building. `roomIdx` and `opIdx` index into the flat `PLAN.rooms` / `PLAN.openings`
arrays.

Consequence: a new geometry source only has to fill that struct. Adding image
import and adding a second floor were both *producers*, not solver rewrites.

### Two geometry sources

`fillLayer()` branches on `PLAN.src[f]`:

- `"vector"` — axis-aligned rectangles in `PLAN.footprint` / `rooms` / `openings`.
- `"raster"` — an imported mask in `PLAN.masks[f]`, resampled with a
  coverage-weighted vote (not nearest-neighbour) so a partition thinner than one
  solver cell still reads as wall at the coarse 18 cm cell the best-spot search
  uses.

### Floors

Floors are layers of one grid, not separate grids. `solveAP` gets two extra
neighbours per cell (up/down) costing `PLAN.floorH` in path length plus the slab
loss in dB. `R.slabOpen[column]` is 1 where there is no slab — inside a
stairwell rectangle, or where both floors are outdoors (which is why signal can
leave a window downstairs, travel up outside, and re-enter upstairs).

### Rendering

One canvas, one panel per floor. `drawFloor(f)` does `ctx.translate(view.pan[f], 0)`
then clips to the panel, so all the existing `W2SX`/`W2SY` math works unchanged
per panel and one floor can never bleed into the next.

### Image import (`planimport.js`)

Pure functions, no DOM — it takes `ImageData` and returns typed arrays. Pipeline:
auto-detect a detector (flat-fill colour vs dark ink) → segment → `close` then
`open` (that order: close welds hatching into a solid band, open then deletes
dimension lines and text) → `buildGeometry`.

**Do not replace the room/doorway segmentation with a morphological closing.**
That was tried and it cannot work: a 97 cm box room is narrower than a 100 cm
door, so no single closing radius both seals every doorway and spares every
room. The current approach erodes the free space by half a door width — every
doorway pinches shut, every room survives as a core — regrows the cores, and
takes the seam between two of them as the doorway. It also means a hole in an
exterior wall makes a seam rather than leaking the outdoors into the house.

## Invariants worth knowing before you edit

- **`PLAN.rooms` / `openings` / `footprint` are flat arrays with a `.floor`
  field.** Imported masks store *flat indices* into them. Any code that adds or
  removes entries must remap every other floor's `mask.roomIdx` / `mask.opIdx`
  — see `dropFloorGeometry()`, `addUpperFloor()`, `removeUpperFloor()`.
- **Bump `geomVersion` after any geometry change.** `rasterCache` is keyed on
  `cell + "|" + geomVersion`; forget it and the solver silently reuses stale
  geometry.
- **`REF_WALL_T = 0.37` is the material table's reference thickness, not the
  plan's.** The wall figures are quoted per 37 cm assembly; that constant, not
  `PLAN.wallT`, converts them to dB/m. Using `PLAN.wallT` makes every wall cost
  the same regardless of thickness.
- **`MARGIN` (solver) and `viewMargin()` (drawing) are different on purpose.**
  The solver always models 120 cm of outdoors; with two panels only 60 cm is
  drawn and the rest is clipped.
- **Imported rooms carry `lx`/`ly`** — the point furthest from any wall, so an
  L-shaped room's caption doesn't land in a corridor. Rendering falls back to
  the bbox centre when they're absent.
- **CSS: several component rules set `display`, which beats the UA `[hidden]`
  rule.** `[hidden]{display:none!important}` in `styles.css` exists for that
  reason; this bug appeared twice before it was fixed globally.
- **Analytics must stay out of the markup.** `consent.js` injects `gtag.js` only
  after the visitor accepts; declining means the script is never fetched. Do not
  move the tag into `index.html`, and keep `terms.html` accurate if data
  handling changes — it currently claims, truthfully, that the app makes no
  network requests and stores nothing but the cookie choice.

## Deployment

`server-settings/aws-setup.md` is the runbook: private S3 bucket, CloudFront
with Origin Access Control, ACM certificate in us-east-1, Route 53 alias
records. Redeploy is `aws s3 sync website/ "s3://$BUCKET" --delete` plus an
invalidation if you don't want to wait out the 5-minute asset TTL.

Assets are cached 5 minutes and the HTML revalidates every request, because
filenames are not content-hashed.

**Keep real AWS values out of this repository.** The runbook is deliberately
parameterised — no account ID, bucket name, distribution ID, certificate ARN or
hosted zone ID is committed, and it should stay that way.
