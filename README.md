# dom-3d — house walkthrough (stage 1)

First-person walkthrough of the house, generated from the architect's PDF plans
(kept locally, not in the repo) and the window offers (`plany\okna`).

## Run

```bash
npm install
npm run dev          # http://localhost:5173  (open it in the Windows browser)
```

Controls: click to walk in · `WASD` walk (2.6 m/s) · `Shift` run (5.5 m/s) · `Q` render quality (photo: ambient occlusion + sky lighting + AgX tone mapping / fast) · `C` crouch · `N` navigation mode (`1` front, `2` back, `3` dining room terrace, `4` garage side, `F` flight like Minecraft: Space up / left Shift down; N starts as flying ghost, `G` ghost: pass through any obstacle; click = read the point under the crosshair (x, y, z + which mesh; listed bottom-left, copied to clipboard; Z undo, X clear); `V` = next facade design) · mouse look ·
`P` plan overlay on the floor · `R` roof · `U` attic · `L` light in your room, `L L` (double) all lights on your floor (lighting design per room in `lighting` in the config: opal ceiling lamps in rooms, 3 dining pendants, LED downlights only in hall/corridors/bathrooms, kitchen beam strip, bathroom mirror strip, garage/utility battens) · `O` overview (orbit) · `M` minimap · `T` tape measure (click two points at the crosshair, distance in cm; `N` vertex snap, `Z` undo, `X` clear) · `Esc` menu (teleport to any room).

## Checks

`npm run build` type-checks and builds. `npm run smoke` (against `npm run preview`) loads the built site headless and fails on any page error or HTTP 4xx/5xx; CI runs it before deploying. Headless tools in `tools/` (`walktest`, `gaps`, `shot`) find Chromium via `$CHROME_PATH` or the newest `~/.cache/ms-playwright/chromium-*` (`npx playwright-core install chromium`).
`public/house.json` is committed output of `npm run data`: after editing `data/house-config.json` re-run it and commit both.

## How the model is made

`npm run data` (Python, `tools/build_house.py`) reads the vector PDFs and writes `public/house.json`:

| What | Source |
|---|---|
| Walls (both floors) | bold 1.44 pt outlines in *Rzut parteru* / *Rzut poddasza*, polygonized, 1 pt = 3.5278 cm at 1:100 |
| Rooms & floor areas | spaces enclosed by walls + openings; areas match the plan tables to ±0.1 m² |
| Roof | planes read from *Rzut dachu*: main ridge +8.48, cross-gables +7.59 / +7.55, garage hip +6.39, pitch 38° |
| Openings, heights, stairs | hand-entered in **`data/house-config.json`** (from plans, sections A-A / B-B and the WIKĘD offers) |

Edit `data/house-config.json` and re-run `npm run data` to correct anything (window positions/heights, room names,
spawn point, roof thickness). Requires the Python venv: `python3 -m venv .venv && .venv/bin/pip install pymupdf shapely pillow`.

Orientation (fitted on the geoportal orthophoto, `site` in the config): the entrance/garage side (plan down) faces **115° (ESE)**, plan right faces 25° (NNE). Sun is computed for 53.19°N 18.08°E; set month and time in the menu. The minimap has a north arrow.

## Rendering

- Photo-scanned PBR materials (colour + normal + roughness) from Poly Haven (CC0), fetched and colour-graded by
  `tools/fetch_textures.py` into `public/textures/` (screed floor, white plaster, raw pine boarding, oak veneer, wool, linen, jute, grass, paving).
- Sky lighting: the sky (with static clouds) is pre-filtered into an environment map.
- Ambient occlusion (GTAO) on the real depth buffer, AgX tone mapping; furniture has rounded edges.

## Current-state assumptions (stage 1)

- Floors: raw concrete screed at finished level ±0.00 (garage −0.15, attic +3.34, room 2/8 +2.99).
- Floors: one continuous concrete surface per floor height, running through all doorways (no sill blocks in doors).
- Inside walls plastered; ground-floor ceilings plastered at +2.93 (garage +2.57).
- Outside (site photos, Oct 2026): raw aerated-concrete blocks with a grey concrete ring-beam band at slab level; no render/EPS yet (EPS only in patches, not modelled).
- Anthracite metal flashing around all roof edges (verge + eaves), per site photo.
- Planned attic ceiling (key `I`: off → insulation → finished): flat plasterboard ceiling 2.80 m above each room floor; slopes: 5 cm vent gap, 15 cm wool between rafters, 15 cm under, 2×12.5 mm plasterboard; 30 cm wool on the flat ceiling (`atticFinish` in the config).
- Covered terrace and entrance canopy: overhanging slab, bare concrete underside.
- Roof underside: full pine boarding on the rafters (as on the photos), also under the overhangs.
- Attic: no ceiling yet — the underside of the roof (rafters 8×16 every ~90 cm + membrane) is visible.
  Rafters are 3D timbers 8×20 cm every ~90 cm (spacing assumed), plumb-cut at the eaves; hip/valley rafters same.
  Collar ties (jętki) 2×4×20 cm: J1 main roof underside +6.79, J2 west gable +6.59, east gable +6.55 (assumed).
  The roof plane is the underside of the rafters; membrane on the rafters, tiles `roof.thickness` (0.34 m) above.
- Entrance walls as on site (photos 2026-11-21): raw concrete piers either side of the recess, concrete lintel over the door opening, bare sand in front with a crushed-stone pad at the threshold (no paving yet). The door stays the planned one; the temporary OSB door seen on site (hinged on the right, opens outward, fixed OSB panel instead of the sidelight) is switchable in the facade menu ("Entrance door").
- Planned front door Dz1: Barański DB 107 (linia Retro) in RAL 5011 with sidelight W1, opens outward. Leaf layout (3 raised panels), brass hardware and hinge side (left, owner's choice; the drawing has it on the sidelight side), four hinges and the sidelight bars follow the product drawing on baranskidrzwi.pl. Opens/closes with `E`.
- Juliet balconies on the 4 attic balcony doors built from `balkon_francuski/*.dxf` (posts, 3 rails, balusters, rings, fixed anthracite, same as the roof tiles; facade designs do not change it).
- One downstand beam between kitchen and dining (24 cm wide, underside +2.63 read from the plan label 311/263).
- Garage door: Hörmann LPU 67 Thermo, L-ribbed, matt RAL 7016 anthracite (chosen, A); alternatives B oak Decograin, C flat RAL 5011 — `G` cycles, `E` opens.
- Bays (east/west gables): walls rise to the bay roof only over the bay walls (`wallRect`, measured on Elewacje); the bay roof rakes overhang the main roof. Slots are closed only inside the house walls (bay side-wall triangles); `tools/gaps.mjs` checks for holes.
- No interior doors installed; the side door Dz2 and the garage gate are shown as open frames.
- Windows per the WIKĘD offers (confirmed by owner): black HS 2440 in OB1 (arcade, opening widened symmetrically
  from 1.80 m), HS MOVE 1935 in W2 (kitchen/dining). Kitchen corner window glazing meets at the corner.
- Roof covering: Braas Turmalin, Anthrazit (matt engobe), per the Braas datasheet GD 356 (03/2016): tile 475 x 280 mm, cover width 240 mm, cover length 355–380 mm (each roof face gets a whole number of courses, first nose at the eave, first column at the verge), 25–30 mm thick, laid in straight columns, 11.0–11.7 tiles/m², 4.4 kg, minimum pitch 25°.
- All window frames incl. both HS sliding doors in Winchester wood decor. Roof windows 78×118 (2× over 2/6, 2× over 2/8), roof hatch 45×55,
  chimney 0.88×0.74 to +8.99 in grey clinker — all positioned from *Rzut dachu* (`roofItems` / `chimney` in the config).

## Dev tools

- `node tools/shot.mjs <outDir> '<views json>'` — headless screenshots (needs the dev server running).
- `node tools/walktest.mjs` — simulated walking with fixed time steps (doorways on both floors, stairs, balcony stop, front door).

## Interior design (v1)

`F` toggles furniture (`furniture` in the config, `src/furniture.ts`). Ground-floor day zone follows the architect's furniture on *Rzut parteru*: kitchen L-counter with sink under the window, tall fridge column, bar counter with 3 stools on the dining side of the beam, 6-seat oak table, 3-seat sofa + loveseat, coffee table, TV wall. Lights follow it: 3 pendants over the bar (between kitchen and dining), linear pendant over the table, ceiling lamps over the sofa area and in the kitchen. With the attic hidden (`U`) the ground-floor ceilings hide too, so the overview (`O`) shows a furnished plan.

Attic (v1): 2/4, 2/5, 2/2 bedrooms with 160 cm beds on the partition walls (high side), built-in wardrobes where headroom ≥ 2.2 m, low dressers under the slopes, bedside table lamps; 2/3 walk-in shelving; 2/6 freestanding tub under the roof windows, walk-in shower, double vanity + mirror strip, wall-hung WC; 2/7 washer/dryer column + counter; 2/8 gym (mat, treadmill, bench, dumbbell rack). Ceiling lamps re-centred on each room's free floor.
