# Pet spec: the Morte spritesheet

What `pipeline/build_pet.py` produces and why each number is what it is. If you
change the build, update this file in the same commit.

## Package (OpenPets / Codex pet format)

| File | V2 (shipped) | V1 (alternative) |
|---|---|---|
| `pet.json` | `id: "morte"`, `spriteVersionNumber: 2`, `gazeAnchor: {x: 0.5, y: 0.25}` | same without those two fields |
| `spritesheet.webp` | 1536×2288 (8 cols × 11 rows of 192×208), lossless WebP, alpha, single frame | 1536×1872 (8 × 9) |

The package folder must be named `morte` (OpenPets requires folder name = `id`).
OpenPets rejects a V2 import whose atlas isn't exactly 1536×2288 alpha WebP.
`build_pet.py` asserts the same checks after writing.

**Why V2 ships:** V2 adds the 16 cursor-gaze cells, which Morte's game data
gives us for free (see below). The trade-off is that in V2 OpenPets shows the
static neutral cell (row 0, col 6) whenever the pet is idle, so the idle bob in
row 0 never plays. V1 keeps the idle bob and drops gaze. Both share the same id,
so only one can be installed at a time.

## Source: game data

Morte's creature animation is 12 BAM V1 files in `data/CA_mrt.bif`, named
`C<anim>MRTB` (EE did not repaint or move them; `PATCH32.bif` has no overrides).

| Anim | Meaning | Cycles × frames |
|---|---|---|
| `CSTD` | stand (subtle bob) | 5 × 12 |
| `CWLK` | walk | **9** × 16 |
| `CRUN` | run | 9 × 12 |
| `CTK1` / `CTK2` | talk (TK2: jaw opens) | 5 × 12 |
| `CHIT` | hit (a spin) | 5 × 12 |
| `CDFB` | die / fall to the ground | 5 × 16 |
| `CGUP` | get back up | 5 × 16 |
| `CSF1` | head-turn flourish | 5 × 16 |
| `CSF2` | chattering-teeth spell (very tall) | 5 × 16 |
| `CAT1` / `CAT2` | bob attack / bite | 5 × 16 |

Orientation: 5-cycle BAMs are S, SW, W, NW, N (cycle 0 = facing the camera);
the 9-cycle walk/run BAMs step S→N in 22.5° increments down the west side.
East-facing poses are mirrors. The art faces screen-left in the W cycles.

Palette: index 0 transparent, index 1 is the engine shadow (opaque black in
data, drawn translucent in-game).

## Rendering rules

- **Scale:** integer 3× nearest-neighbor. Keeps the pixel art honest; Morte's
  skull ends up ~60×60 px of the 192×208 cell (~45 px on screen at OpenPets'
  default Medium 0.75).
- **Anchor:** each frame's BAM center point (the "feet" = shadow center) is
  placed at (96, 199) in the cell, so frames don't jitter.
- **Shadow:** palette-index-1 pixels get alpha 110.
- **Clipping budget:** Morte's full vertical range (skull top to shadow bottom)
  is 73 source px; the cell holds 69 at 3×. With the anchor above, the worst
  loss is 2 px of skull crown on one `jumping` frame and a few px of shadow
  edge on the lowest bob frames. The build reports 31 clipped cells; that's
  expected. Changing `ANCHOR_Y` moves the loss between skull and shadow.
- **Frame counts** are fixed by the host per row; long game cycles are sampled
  evenly (`pick()`), so timing on short loops is slightly irregular.

## Row mapping (rows 0–8: standard OpenPets/Codex order)

| Row | State | Frames | Source |
|---|---|---|---|
| 0 | idle | 6 | `CSTD` c0, every other frame; **col 6 = neutral pose** (`CSTD` c0 f0) |
| 1 | running-right | 8 | `CWLK` c4 (W) mirrored |
| 2 | running-left | 8 | `CWLK` c4 (W) |
| 3 | waving | 4 | `CTK2` c0 |
| 4 | jumping | 5 | `CHIT` c0 (spin) |
| 5 | failed | 8 | `CDFB` c0 (falls to the ground) |
| 6 | waiting | 6 | `CTK1` c0 |
| 7 | running | 6 | `CRUN` c0 (run in place, facing camera) |
| 8 | review | 6 | `CSF1` c0 frames 3–13 |

Left out: `CSF2` (too tall), `CAT1`/`CAT2` (too tall/wide), `CGUP`.

## Gaze rows (V2 only: rows 9–10)

Sixteen cells, clockwise from screen-up in 22.5° steps (row 9: 0°–157.5°, row 10:
180°–337.5°). Each is frame 0 of a `CWLK` cycle: west half (180°–337.5°) uses
cycles c0…c7 directly, 0° uses c8 (north: back of the skull), east half
(22.5°–157.5°) mirrors c7…c1. Walk frame 0 sits at the same height as the stand
pose in all nine orientations, so switching gaze doesn't jitter.

## `gazeAnchor`

OpenPets measures the gaze angle from a point on the pet. Without `gazeAnchor`
it uses the bottom-center of the pet window, which for Morte is his shadow, so a
cursor anywhere on his body reads as "up" and he turns away. `gazeAnchor` is a
point in one 192×208 frame, normalized to [0, 1] from the top-left, before
flipping. Measured skull center in the neutral frame is (0.497, 0.262); across
all 16 gaze cells it stays within x 0.46–0.54, y 0.20–0.26, so the anchor is
(0.5, 0.25). OpenPets keeps a 24 px dead zone around the anchor, which at Medium
covers most of the skull.
