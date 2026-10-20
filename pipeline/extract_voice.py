#!/usr/bin/env python3
"""Extract Morte's voice clips from a Planescape: Torment EE install.

    python pipeline/extract_voice.py --game "<gamepath>"
    python pipeline/extract_voice.py --game "<gamepath>" --list            # every Morte clip, with subtitle/label

Reads the curated selection in hook/clips.json ("clips": category -> [resref]) and writes
hook/clips/<RESREF>.wav (mono 22.05 kHz PCM, peak-normalised to -1 dBFS). Writes each
clip's "label" (its dialog.tlk text) and "dur" to hook/clips.meta.json, and regenerates
hook/audition.html for listening to them. Both are game-derived, so both are gitignored.

Needs ffmpeg on PATH (its `acm` demuxer decodes the game's Interplay ACM audio).
The clips are copyrighted game audio, never commit or publish them.
"""
from __future__ import annotations

import argparse
import html
import json
import os
import re
import shutil
import struct
import subprocess
import sys
import tempfile

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from ie import Game, read_tlk  # noqa: E402

TYPE_WAV = 0x0004
REPO = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
HOOK = os.path.join(REPO, "hook")
PEAK_DBFS = -1.0


def wavc_to_acm(d: bytes) -> tuple[bytes, float]:
    """WAVC header: sig, ver, uncompressed size, compressed size, header size, channels, bits, rate."""
    if d[:4] != b"WAVC":
        raise ValueError(f"expected WAVC, got {d[:4]!r}")
    usize, _csize, hsize, ch, bits, rate = struct.unpack_from("<IIIHHH", d, 8)
    return d[hsize:], usize / (ch * bits / 8 * rate)


def ffmpeg(*args: str) -> subprocess.CompletedProcess:
    return subprocess.run(["ffmpeg", "-hide_banner", *args], capture_output=True, text=True)


def decode_normalised(acm: bytes, out_path: str) -> None:
    with tempfile.TemporaryDirectory() as tmp:
        src, raw = os.path.join(tmp, "in.acm"), os.path.join(tmp, "raw.wav")
        open(src, "wb").write(acm)
        r = ffmpeg("-v", "error", "-y", "-i", src, "-ac", "1", "-ar", "22050", raw)
        if r.returncode:
            raise RuntimeError(f"ffmpeg could not decode ACM: {r.stderr.strip()[:300]}")
        peak = ffmpeg("-i", raw, "-af", "volumedetect", "-f", "null", "-").stderr
        m = re.search(r"max_volume:\s*(-?[\d.]+) dB", peak)
        gain = PEAK_DBFS - float(m.group(1)) if m else 0.0
        r = ffmpeg("-v", "error", "-y", "-i", raw, "-af", f"volume={gain}dB",
                   "-ar", "22050", "-ac", "1", "-c:a", "pcm_s16le", out_path)
        if r.returncode:
            raise RuntimeError(r.stderr.strip()[:300])


def subtitles(game_root: str, lang: str) -> dict[str, str]:
    path = os.path.join(game_root, "lang", lang, "dialog.tlk")
    subs: dict[str, str] = {}
    for _ref, snd, text in read_tlk(path):
        if snd and snd not in subs:
            subs[snd] = text.split("\n")[0][:80]
    return subs


def is_morte(name: str) -> bool:
    return name.startswith("MRT") or name.startswith("AM_MRT")


def audition(clips: dict, lines: dict) -> str:
    """Local listening page; clips/ sits next to it. Not committed (it is regenerated)."""
    titles = {"thinking": "Prompt received", "working": "Editing / running / testing",
              "permission": "Needs approval", "question": "Asks you a question",
              "idle": "Waiting for you", "ambientBored": "Idle plugin: Bored", "ambientEngaged": "Idle plugin: Engaged", "success": "Finished", "error": "Failed"}
    line_keys = {"working": ["editing", "testing", "running"], "ambientBored": ["ambientBored", "ambientQuipsBored"], "ambientEngaged": ["ambientEngaged", "ambientQuipsEngaged"]}
    sections = []
    for cat, ids in clips["clips"].items():
        rows = "".join(
            f'<li><code>{i}</code><span>{html.escape(clips["meta"][i]["label"])}</span>'
            f'<span class="d">{clips["meta"][i]["dur"]}s</span>'
            f'<audio controls preload="none" src="clips/{i}.wav"></audio></li>' for i in ids)
        keys = line_keys.get(cat, [cat])
        bubble = "".join(f"<li>{html.escape(t)}</li>" for k in keys for t in lines.get(k, []))
        sections.append(f'<section><h2>{titles.get(cat, cat)} <small>{cat}</small></h2><ul class="c">{rows}</ul>'
                        f'<details><summary>Bubble lines ({sum(len(lines.get(k, [])) for k in keys)})</summary>'
                        f'<ul class="l">{bubble}</ul></details></section>')
    return f"""<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Morte Voice Audition</title><style>
:root{{--bg:#16130f;--card:#211c16;--ink:#e9dfc9;--mute:#9c8f78;--acc:#d9b45c;--line:#3a3127}}
*{{box-sizing:border-box}}body{{margin:0;background:var(--bg);color:var(--ink);font:15px/1.5 Georgia,serif;padding:24px 16px}}
main{{max-width:860px;margin:auto}}h1{{font-weight:normal;color:var(--acc);margin:0 0 4px}}p{{color:var(--mute);margin:0 0 24px}}
section{{background:var(--card);border:1px solid var(--line);border-radius:8px;padding:14px 16px;margin:0 0 16px}}
h2{{font-size:18px;margin:0 0 10px;font-weight:normal}}small{{color:var(--mute);font:12px monospace;margin-left:6px}}
ul{{list-style:none;margin:0;padding:0}}.c li{{display:grid;grid-template-columns:80px 1fr 44px minmax(160px,240px);gap:10px;align-items:center;padding:6px 0;border-top:1px solid var(--line)}}
.c li:first-child{{border-top:0}}code{{color:var(--acc);font-size:12px}}.d{{color:var(--mute);font:12px monospace;text-align:right}}audio{{width:100%;height:30px}}
details{{margin-top:10px}}summary{{cursor:pointer;color:var(--mute)}}.l li{{padding:3px 0 3px 12px;border-left:2px solid var(--line);margin:4px 0;font-style:italic}}
@media (max-width:640px){{.c li{{grid-template-columns:70px 1fr 40px}}audio{{grid-column:1/-1}}}}
</style></head><body><main><h1>Morte, auditioning</h1>
<p>Every clip and bubble line the hook can pick. Drop a clip by removing its id from <code>clips.json</code>; edit lines in <code>lines.json</code>, then <code>node morte-hook.js --check</code>.</p>
{"".join(sections)}</main></body></html>
"""


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--game", required=True, help="Planescape: Torment EE install folder (contains chitin.key)")
    ap.add_argument("--lang", default="en_US", help="dialog.tlk language folder (default en_US)")
    ap.add_argument("--selection", default=os.path.join(HOOK, "clips.json"))
    ap.add_argument("--meta", default=os.path.join(HOOK, "clips.meta.json"))
    ap.add_argument("--out", default=os.path.join(HOOK, "clips"))
    ap.add_argument("--list", action="store_true", help="list every Morte clip (resref, seconds, subtitle) and exit")
    args = ap.parse_args()

    game = Game(args.game)
    subs = subtitles(args.game, args.lang)

    if args.list:
        for name in (n for n in game.names(TYPE_WAV) if is_morte(n)):
            try:
                _acm, dur = wavc_to_acm(game.read(name, TYPE_WAV))
            except (ValueError, KeyError) as e:
                print(f"{name:10s}  ??    ({e})")
                continue
            print(f"{name:10s} {dur:4.1f}s  {subs.get(name, '(no subtitle)')}")
        return 0

    if not shutil.which("ffmpeg"):
        print("ffmpeg not found on PATH (needed to decode the game's ACM audio)", file=sys.stderr)
        return 1
    sel = json.load(open(args.selection, encoding="utf-8"))
    wanted = sorted({c for ids in sel["clips"].values() for c in ids})
    os.makedirs(args.out, exist_ok=True)
    meta = {}
    for name in wanted:
        acm, dur = wavc_to_acm(game.read(name, TYPE_WAV))
        decode_normalised(acm, os.path.join(args.out, f"{name}.wav"))
        meta[name] = {"label": subs.get(name, ""), "dur": round(dur, 1)}
        print(f"{name:10s} {dur:4.1f}s  {meta[name]['label']}")
    sel["meta"] = meta  # for audition() only; the committed selection is not rewritten
    with open(args.meta, "w", encoding="utf-8", newline="\n") as fh:
        json.dump(meta, fh, indent=1)
        fh.write("\n")
    lines = json.load(open(os.path.join(HOOK, "lines.json"), encoding="utf-8"))
    with open(os.path.join(os.path.dirname(args.out), "audition.html"), "w", encoding="utf-8", newline="\n") as fh:
        fh.write(audition(sel, lines))
    print(f"{len(wanted)} clips -> {args.out}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
