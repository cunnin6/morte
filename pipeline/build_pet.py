#!/usr/bin/env python3
"""Build the Morte OpenPets pet (V2 and V1) from a Planescape: Torment EE install.

    python pipeline/build_pet.py --game "D:/Galaxy/Planescape Torment - Enhanced Edition" [--out dist]

Writes, under --out:
    pet-v2/morte/{pet.json,spritesheet.webp}   1536x2288 atlas, 16 gaze cells (the shipped variant)
    pet-v1/morte/{pet.json,spritesheet.webp}   1536x1872 atlas, animated idle, no gaze
    morte-v2.zip, morte-v1.zip                 for `openpets install --from-zip`
    preview-v2.png, preview-v1.png             labelled contact sheets

The spec for every number in here is docs/pet-spec.md.
Output is copyrighted game art, never commit or publish it.
"""
from __future__ import annotations

import argparse
import json
import os
import sys
import zipfile

import numpy as np
from PIL import Image, ImageDraw

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from bam import decode_bam  # noqa: E402
from ie import Game  # noqa: E402

TYPE_BAM = 0x03E8
SCALE = 3                       # integer nearest-neighbour upscale
CW, CH = 192, 208               # OpenPets / Codex cell
ANCHOR_X = CW // 2              # BAM centre point (the "feet", i.e. shadow centre) lands here
ANCHOR_Y = CH - 3 * SCALE
SHADOW_ALPHA = 110              # palette index 1 is the engine shadow, drawn translucent in-game
GAZE_ANCHOR = {"x": 0.5, "y": 0.25}   # skull centre in the neutral frame (OpenPets PR #249)
ANIMS = ["CSTD", "CWLK", "CRUN", "CTK1", "CTK2", "CHIT", "CDFB", "CSF1"]  # suffix MRTB in game data

PET_META = {
    "id": "morte",
    "displayName": "Morte",
    "description": "Floating skull from Planescape: Torment. Local build from your own game files; not for redistribution.",
    "spritesheetPath": "spritesheet.webp",
}


def pick(n: int, k: int, start: int = 0, end: int | None = None) -> list[int]:
    """k evenly spaced indices from range(start, end) of an n-frame cycle."""
    end = n if end is None else end
    return [int(round(start + i * (end - start) / k)) for i in range(k)]


# Atlas rows 0-8, OpenPets/Codex standard order: (state, anim, cycle, frames, mirror).
# 5-orientation BAMs: cycle 0 = south (facing camera). CWLK has 9: c0=S ... c4=W ... c8=N.
ROWS = [
    ("idle",          "CSTD", 0, pick(12, 6),        False),
    ("running-right", "CWLK", 4, pick(16, 8),        True),
    ("running-left",  "CWLK", 4, pick(16, 8),        False),
    ("waving",        "CTK2", 0, pick(12, 4),        False),
    ("jumping",       "CHIT", 0, pick(12, 5),        False),
    ("failed",        "CDFB", 0, pick(16, 8),        False),
    ("waiting",       "CTK1", 0, pick(12, 6),        False),
    ("running",       "CRUN", 0, pick(12, 6),        False),
    ("review",        "CSF1", 0, pick(16, 6, 3, 14), False),
]


def gaze_cells():
    """16 clockwise sectors from screen-up -> (anim, cycle, frame, mirror). East side mirrors west."""
    out = []
    for i in range(16):
        deg = i * 22.5
        if deg == 0:
            c, m = 8, False
        elif deg < 180:
            c, m = int(round((180 - deg) / 22.5)), True
        else:
            c, m = int(round((deg - 180) / 22.5)), False
        out.append(("CWLK", c, 0, m))
    return out


class Builder:
    def __init__(self, game: Game, anims: list[str] = ANIMS):
        self.bams = {a: decode_bam(game.read(a + "MRTB", TYPE_BAM)) for a in anims}
        self.clipped: set[str] = set()

    def cell(self, anim: str, cyc: int, k: int, mirror: bool, tag: str) -> Image.Image:
        b = self.bams[anim]
        f = b["frames"][b["cycles"][cyc][k]]
        img = f["img"].copy()
        shadow = (img[..., 0] == 0) & (img[..., 1] == 0) & (img[..., 2] == 0) & (img[..., 3] == 255)
        img[shadow, 3] = SHADOW_ALPHA
        im = Image.fromarray(img, "RGBA")
        cx, cy = f["cx"], f["cy"]
        if mirror:
            im = im.transpose(Image.FLIP_LEFT_RIGHT)
            cx = f["w"] - cx
        im = im.resize((im.width * SCALE, im.height * SCALE), Image.NEAREST)
        x, y = ANCHOR_X - cx * SCALE, ANCHOR_Y - cy * SCALE
        if x < 0 or y < 0 or x + im.width > CW or y + im.height > CH:
            self.clipped.add(tag)
        pad = 400  # composite on an oversized canvas, then crop: negative offsets are fine
        c = Image.new("RGBA", (CW + 2 * pad, CH + 2 * pad), (0, 0, 0, 0))
        c.alpha_composite(im, (x + pad, y + pad))
        return c.crop((pad, pad, pad + CW, pad + CH))

    def sheet(self, rows: int) -> Image.Image:
        sh = Image.new("RGBA", (8 * CW, rows * CH), (0, 0, 0, 0))
        for r, (name, anim, cyc, ks, m) in enumerate(ROWS):
            for col, k in enumerate(ks):
                sh.alpha_composite(self.cell(anim, cyc, k, m, f"{name}[{col}]"), (col * CW, r * CH))
        # V2 neutral pose lives at row 0, col 6 (harmless in V1: idle only uses cols 0-5)
        sh.alpha_composite(self.cell("CSTD", 0, 0, False, "neutral"), (6 * CW, 0))
        if rows == 11:
            for i, (a, c, k, m) in enumerate(gaze_cells()):
                sh.alpha_composite(self.cell(a, c, k, m, f"gaze{i * 22.5}"), ((i % 8) * CW, (9 + i // 8) * CH))
        return sh


def preview(sh: Image.Image, rows: int) -> Image.Image:
    pv = Image.new("RGBA", (sh.width + 130, sh.height), (78, 80, 92, 255))
    dr = ImageDraw.Draw(pv)
    for i in range(rows):
        dr.rectangle([130, i * CH, pv.width, i * CH + CH - 1], outline=(60, 60, 70))
    pv.alpha_composite(sh, (130, 0))
    labels = [f"{r[0]}\n{r[1][1:]} x{len(r[3])}" for r in ROWS] + ["gaze 0-157.5", "gaze 180-337.5"]
    for i, label in enumerate(labels[:rows]):
        dr.text((6, i * CH + 8), label, fill=(255, 230, 120))
    dr.text((130 + 6 * CW + 4, 4), "neutral", fill=(140, 220, 255))
    return pv.convert("RGB")


def verify(path: str, size: tuple[int, int]) -> None:
    """The checks OpenPets applies on import: exact size, single-frame, alpha WebP."""
    with Image.open(path) as im:
        im.load()
        assert im.format == "WEBP", im.format
        assert im.size == size, (im.size, size)
        assert getattr(im, "n_frames", 1) == 1
        assert im.mode == "RGBA" and im.getchannel("A").getextrema()[0] == 0


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--game", required=True, help="Planescape: Torment EE install folder (contains chitin.key)")
    ap.add_argument("--out", default="dist", help="output folder (default: dist)")
    args = ap.parse_args()

    b = Builder(Game(args.game))
    for ver, rows in (("v2", 11), ("v1", 9)):
        d = os.path.join(args.out, f"pet-{ver}", "morte")   # folder name must equal the pet id
        os.makedirs(d, exist_ok=True)
        sh = b.sheet(rows)
        sheet_path = os.path.join(d, "spritesheet.webp")
        sh.save(sheet_path, "WEBP", lossless=True, quality=100, method=6, exact=True)
        verify(sheet_path, (8 * CW, rows * CH))
        meta = dict(PET_META)
        if ver == "v2":
            meta["spriteVersionNumber"] = 2
            meta["gazeAnchor"] = GAZE_ANCHOR
        with open(os.path.join(d, "pet.json"), "w", encoding="utf-8", newline="\n") as fh:
            json.dump(meta, fh, indent=2)
            fh.write("\n")
        with zipfile.ZipFile(os.path.join(args.out, f"morte-{ver}.zip"), "w", zipfile.ZIP_DEFLATED) as z:
            z.write(os.path.join(d, "pet.json"), "pet.json")
            z.write(sheet_path, "spritesheet.webp")
        preview(sh, rows).save(os.path.join(args.out, f"preview-{ver}.png"))
        print(f"{ver}: {sh.size[0]}x{sh.size[1]} -> {d}")
    print(f"clipped cells (expected, see docs/pet-spec.md): {len(b.clipped)}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
