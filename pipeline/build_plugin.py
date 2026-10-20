#!/usr/bin/env python3
"""Build the Morte Idle OpenPets plugin from a Planescape: Torment EE install.

    python pipeline/build_plugin.py --game "<gamepath>" [--out dist]
    python pipeline/build_plugin.py --data-only [--out dist]     # after editing lines, moods or clip sets

Needs hook/clips/*.wav for the mood clip sets (clips.ambientBored / ambientEngaged in
hook/clips.json; run pipeline/extract_voice.py first). --data-only skips the game and the sprite
strips: it reuses the strips already in <out>/plugin/morte-idle and refreshes sounds, manifest and
the injected data.

Writes <out>/plugin/morte-idle/, a folder OpenPets loads with Plugins -> Developer Mode ->
"Load unpacked plugin folder":
    openpets.plugin.json   plugin/openpets.plugin.json + the generated sprite/sound declarations
    index.js               plugin/index.js with the mood data injected (moods.json, lines, clip sets)
    assets/sprites/*.webp  square-frame animation strips from the game's BAMs (game art)
    assets/sounds/*.wav    the mood clip sets (game audio)

The spec for every number in here is docs/idle-plugin-spec.md.
Output is copyrighted game art and audio, never commit or publish it.
"""
from __future__ import annotations

import argparse
import json
import os
import shutil
import sys

from PIL import Image

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from build_pet import ANIMS, CH, CW, Builder, gaze_cells, pick  # noqa: E402
from ie import Game  # noqa: E402

REPO = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
FRAME = CH                      # OpenPets draws plugin strips as square frames of the strip's height
MAX_FRAMES = 16                 # plugin-manifest.ts: frames 1..16
MAX_SPRITE_BYTES = 5 * 1024 * 1024
MAX_SOUND_BYTES = 1024 * 1024
EXTRA_ANIMS = ["CGUP"]          # used by "pratfall" and "getup"; not part of the pet atlas
MOODS = ["bored", "engaged", "contemplative"]


def frame_specs(builder: Builder, segments: list[dict]) -> list[tuple[str, int, int, bool]]:
    """Segments -> [(anim, cycle, frame, mirror)] in play order."""
    out: list[tuple[str, int, int, bool]] = []
    for seg in segments:
        if seg.get("gaze"):                       # 16 look directions clockwise = one full turn
            out += list(gaze_cells())
            continue
        anim, cyc = seg["anim"], seg["cycle"]
        n = len(builder.bams[anim]["cycles"][cyc])
        out += [(anim, cyc, k, False) for k in pick(n, seg["count"], seg.get("start", 0), seg.get("end"))]
    return out


def strip(builder: Builder, specs: list[tuple[str, int, int, bool]], name: str) -> Image.Image:
    assert 1 <= len(specs) <= MAX_FRAMES, (name, len(specs))
    sh = Image.new("RGBA", (FRAME * len(specs), FRAME), (0, 0, 0, 0))
    pad = (FRAME - CW) // 2                       # 192-wide pet cell centred in a square frame
    for i, (anim, cyc, k, mirror) in enumerate(specs):
        sh.alpha_composite(builder.cell(anim, cyc, k, mirror, f"{name}[{i}]"), (i * FRAME + pad, 0))
    return sh


def build_sprites(game: str, ambient: dict, dest: str) -> tuple[dict, dict]:
    builder = Builder(Game(game), ANIMS + EXTRA_ANIMS)
    sprites, animations = {}, {}
    for name, a in ambient["animations"].items():
        specs = frame_specs(builder, a["segments"])
        rel = f"assets/sprites/{name}.webp"
        path = os.path.join(dest, rel)
        strip(builder, specs, name).save(path, "WEBP", lossless=True, quality=100, method=6, exact=True)
        assert os.path.getsize(path) <= MAX_SPRITE_BYTES, (name, os.path.getsize(path))
        duration = round(len(specs) / a["fps"] * 1000)
        assert 100 <= duration <= 4000, (name, duration)
        sprites[name] = {"path": rel, "frameWidth": FRAME, "frameHeight": FRAME, "frames": len(specs), "durationMs": duration}
        animations[name] = {"fps": a["fps"], "durationMs": duration, "hop": bool(a.get("hop"))}
        print(f"sprite {name}: {len(specs)} frames @ {a['fps']} fps")
    return sprites, animations


def existing_sprites(ambient: dict, dest: str) -> tuple[dict, dict]:
    """--data-only: reuse the strips from the previous full build."""
    prev = os.path.join(dest, "openpets.plugin.json")
    if not os.path.exists(prev):
        raise SystemExit(f"{prev} not found: run a full build (with --game) first")
    sprites = json.load(open(prev, encoding="utf-8"))["assets"]["sprites"]
    missing = set(ambient["animations"]) - set(sprites)
    if missing:
        raise SystemExit(f"strips missing from the last build: {sorted(missing)}; run a full build (with --game)")
    animations = {n: {"fps": a["fps"], "durationMs": sprites[n]["durationMs"], "hop": bool(a.get("hop"))}
                  for n, a in ambient["animations"].items()}
    return sprites, animations


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--game", help="Planescape: Torment EE install folder (contains chitin.key)")
    ap.add_argument("--out", default="dist", help="output folder (default: dist)")
    ap.add_argument("--data-only", action="store_true", help="skip the game and the sprite strips; reuse the last build's")
    args = ap.parse_args()
    if not args.data_only and not args.game:
        ap.error("--game is required unless --data-only")

    ambient = json.load(open(os.path.join(REPO, "plugin", "ambient.json"), encoding="utf-8"))
    moods = json.load(open(os.path.join(REPO, "plugin", "moods.json"), encoding="utf-8"))["moods"]
    lines = json.load(open(os.path.join(REPO, "hook", "lines.json"), encoding="utf-8"))
    clips = json.load(open(os.path.join(REPO, "hook", "clips.json"), encoding="utf-8"))["clips"]
    manifest = json.load(open(os.path.join(REPO, "plugin", "openpets.plugin.json"), encoding="utf-8"))

    dest = os.path.join(args.out, "plugin", "morte-idle")
    if args.data_only:
        sprites, animations = existing_sprites(ambient, dest)
        shutil.rmtree(os.path.join(dest, "assets", "sounds"), ignore_errors=True)
        os.makedirs(os.path.join(dest, "assets", "sounds"))
    else:
        shutil.rmtree(dest, ignore_errors=True)
        os.makedirs(os.path.join(dest, "assets", "sprites"))
        os.makedirs(os.path.join(dest, "assets", "sounds"))
        sprites, animations = build_sprites(args.game, ambient, dest)

    clip_sets = {m: clips.get("ambient" + m.capitalize(), []) for m in MOODS}
    sounds = {}
    for resref in dict.fromkeys(r for m in MOODS for r in clip_sets[m]):
        src = os.path.join(REPO, "hook", "clips", f"{resref}.wav")
        if not os.path.exists(src):
            print(f"missing {src}; run pipeline/extract_voice.py first", file=sys.stderr)
            return 1
        assert os.path.getsize(src) <= MAX_SOUND_BYTES, (resref, os.path.getsize(src))
        name = resref.lower()
        shutil.copyfile(src, os.path.join(dest, "assets", "sounds", f"{name}.wav"))
        sounds[name] = f"assets/sounds/{name}.wav"
    print(f"{len(sounds)} sounds")

    manifest["assets"] = {"sprites": sprites, "sounds": sounds}
    with open(os.path.join(dest, "openpets.plugin.json"), "w", encoding="utf-8", newline="\n") as fh:
        json.dump(manifest, fh, indent=2)
        fh.write("\n")

    data = {
        "animations": animations,
        "moods": {
            m: {
                "paceMul": moods[m]["paceMul"],
                "weights": moods[m]["weights"],
                "sounds": [r.lower() for r in clip_sets[m]],
                "lines": lines["ambient" + m.capitalize()],
                "quips": lines["ambientQuips" + m.capitalize()],
            }
            for m in MOODS
        },
    }
    src = open(os.path.join(REPO, "plugin", "index.js"), encoding="utf-8").read()
    assert '"__AMBIENT__"' in src
    with open(os.path.join(dest, "index.js"), "w", encoding="utf-8", newline="\n") as fh:
        fh.write(src.replace('"__AMBIENT__"', json.dumps(data, ensure_ascii=False), 1))

    if not args.data_only:
        # contact sheet for eyeballing, next to the plugin (not inside it)
        names = list(sprites)
        sheet = Image.new("RGBA", (FRAME * MAX_FRAMES, FRAME * len(names)), (78, 80, 92, 255))
        for r, n in enumerate(names):
            with Image.open(os.path.join(dest, sprites[n]["path"])) as im:
                sheet.alpha_composite(im.convert("RGBA"), (0, r * FRAME))
        sheet.convert("RGB").save(os.path.join(args.out, "plugin", "preview-idle.png"))
    print(f"plugin -> {dest}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
