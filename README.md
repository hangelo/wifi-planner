# WiFi Planner

Estimate how a Wi-Fi signal spreads through a home, from the actual wall
geometry rather than a circle drawn around the router.

**→ [wifiplanner.handcraftingcodes.com](https://wifiplanner.handcraftingcodes.com)**

Drag the router across a floor plan and the coverage map is re-solved from
scratch. Signal takes the cheapest route it can find — through masonry where
that is cheapest, around it through doorways where it is not — so a room on the
far side of two brick walls goes dark while a room reached through an open door
stays lit.

Nothing is uploaded. Floor plans you import are decoded, measured and solved
entirely in your browser; there is no server behind the site and no account.

## What it does

- **Coverage from real geometry.** A least-loss path search over a raster of
  the plan, not free-space distance. Hovering traces the path the signal
  actually took to reach that point.
- **Import your own floor plan.** Drop in a PNG or JPEG. It segments the walls
  out of the drawing, you set the scale by dragging along a printed dimension,
  and rooms and doorways are derived from the result. A brush fixes anything
  the detector got wrong, and a one-click Door tool punches doorways where the
  drawing shows them as symbols rather than gaps.
- **Two storeys.** Floors are solved as coupled layers of one grid, joined
  through the floor slab. Draw a stairwell and signal crosses there for free,
  which is usually the only reason an upstairs router reaches downstairs.
- **Find best spot.** Searches every reachable position — on both floors — for
  the placement covering the most floor area above your target level.
- **Readouts that mean something.** Per-room median and 5th-percentile RSSI,
  coverage percentage against a target you choose, and an estimated TCP
  throughput from the SNR-to-MCS mapping.

Adjustable: band (2.4 / 5 GHz), transmit power, antenna gain, channel width
(20/40/80 MHz), spatial streams, a clutter exponent for furnishing, wall and
slab construction, and what fills each opening — from an open doorway to a
metal door.

## The model

A dominant-path search: bucket-queue Dijkstra over a grid of the plan, where
each cell carries an attenuation rate and each step pays distance spreading
plus the material it passes through. A saturating diffraction penalty charges
paths that bend a long way around obstacles, so going around a wall is cheaper
than going through it but not free.

Wall and door figures are whole-assembly values quoted per 37 cm; the solver
scales them by the thickness it actually measures. The grid extends beyond the
building because signal genuinely travels around the outside and back in.

Sources for the propagation model and the material tables — ITU-R P.1238 /
P.2040 / P.526, COST 231 Multi-Wall, NIST IR 6055 and others — are cited under
**How the simulation works, and where the numbers come from** at the bottom of
the app.

These are estimates, not measurements. Foil-backed insulation, pipework,
appliances, furniture, people and the neighbours' networks all change the real
answer and none of them are modelled. Use it to compare one router position
against another, not as a survey.

## Running it locally

No build step, no dependencies, no package manager.

```bash
cd website
python3 -m http.server 8777
```

Then open <http://localhost:8777>. Opening `index.html` over `file://` also
works, except for the clipboard export, which needs a secure context.

## Layout

```
website/          the entire app, served as it is
server-settings/  AWS hosting runbook (S3 + CloudFront + ACM + Route 53)
CLAUDE.md         architecture notes and invariants for working on the code
```

`CLAUDE.md` is the place to start if you intend to change anything: it explains
the raster contract everything hangs off, how floors are layered, and the
handful of invariants that fail silently when broken.

## Deploying

`server-settings/aws-setup.md` sets up a private S3 bucket behind CloudFront
with a certificate from ACM and alias records in Route 53. It is parameterised —
no account, bucket or distribution values are committed. Redeploying is an
`aws s3 sync` of `website/`.

## Licence

None yet, which by default means all rights reserved.
