"""Decoder for Infinity Engine BAM V1 animations (plain or BAMC zlib-wrapped).

Returns frames as RGBA numpy arrays plus each frame's centre point, and cycles
as lists of frame indices. Palette rules (as the engine draws them):
  * index 0 / the first pure-green entry is transparent;
  * an alpha byte of 0 in the palette means opaque (legacy BAMs never set alpha);
  * index 1 is the engine's shadow colour (black); callers decide its alpha.
"""
from __future__ import annotations

import struct
import zlib

import numpy as np


def decode_bam(d: bytes) -> dict:
    if d[:4] == b"BAMC":
        d = zlib.decompress(d[12:])
    if d[:8] != b"BAM V1  ":
        raise ValueError(f"unsupported BAM: {d[:8]!r} (only BAM V1 / BAMC are handled)")
    n_frames, n_cycles, rle_index, off_frames, off_pal, off_lookup = struct.unpack_from("<HBBIII", d, 8)

    pal = np.frombuffer(d[off_pal:off_pal + 1024], dtype=np.uint8).reshape(256, 4)
    rgb = pal[:, [2, 1, 0]].copy()                      # stored BGRA
    alpha = np.where(pal[:, 3] == 0, 255, pal[:, 3])
    transparent = next((i for i in range(256) if tuple(rgb[i]) == (0, 255, 0)), 0)
    rgba = np.concatenate([rgb, alpha[:, None]], 1).astype(np.uint8)
    rgba[transparent, 3] = 0

    frames = []
    for i in range(n_frames):
        w, h, cx, cy, off = struct.unpack_from("<HHhhI", d, off_frames + 12 * i)
        raw = bool(off & 0x80000000)
        off &= 0x7FFFFFFF
        n = w * h
        if raw:
            px = np.frombuffer(d[off:off + n], dtype=np.uint8)
        else:                                            # RLE: only rle_index runs are encoded
            out, p = bytearray(), off
            while len(out) < n:
                c = d[p]; p += 1
                if c == rle_index:
                    out.extend([c] * (d[p] + 1)); p += 1
                else:
                    out.append(c)
            px = np.frombuffer(bytes(out[:n]), dtype=np.uint8)
        img = rgba[px].reshape(h, w, 4) if n else np.zeros((1, 1, 4), np.uint8)
        frames.append({"img": img, "cx": cx, "cy": cy, "w": w, "h": h})

    off_cycles = off_frames + 12 * n_frames
    cycles = []
    for i in range(n_cycles):
        count, first = struct.unpack_from("<HH", d, off_cycles + 4 * i)
        cycles.append([struct.unpack_from("<H", d, off_lookup + 2 * (first + k))[0] for k in range(count)])
    return {"frames": frames, "cycles": cycles}
