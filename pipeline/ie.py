"""Minimal Infinity Engine resource access: chitin.key, BIFF v1 archives, dialog.tlk.

Only what this project needs. Resources resolve the way the engine does:
`override/<NAME>.<ext>` first, then the BIF that chitin.key points to.
"""
from __future__ import annotations

import os
import struct

# Resource type codes -> extensions (subset; see IESDP "KEY file format").
EXT = {
    0x0001: "bmp", 0x0004: "wav", 0x03E8: "bam", 0x03E9: "wed", 0x03EB: "tis",
    0x03EC: "mos", 0x03ED: "itm", 0x03EF: "bcs", 0x03F0: "ids", 0x03F1: "cre",
    0x03F2: "are", 0x03F3: "dlg", 0x03F4: "2da", 0x0404: "pvrz",
}


class Game:
    """A Planescape: Torment (EE) install, read-only."""

    def __init__(self, root: str):
        self.root = root
        key_path = os.path.join(root, "chitin.key")
        if not os.path.isfile(key_path):
            raise FileNotFoundError(f"chitin.key not found under {root!r} (pass the game's install folder)")
        self.bifs, self.index = self._read_key(key_path)
        self._bif_cache: dict[str, dict[int, bytes]] = {}

    @staticmethod
    def _read_key(path: str):
        d = open(path, "rb").read()
        sig, ver, n_bif, n_res, off_bif, off_res = struct.unpack_from("<4s4s4I", d, 0)
        if sig != b"KEY " or ver != b"V1  ":
            raise ValueError(f"not a KEY V1 file: {sig!r} {ver!r}")
        bifs = []
        for i in range(n_bif):
            _len, name_off, name_len, _loc = struct.unpack_from("<IIHH", d, off_bif + 12 * i)
            bifs.append(d[name_off:name_off + name_len].rstrip(b"\0").decode("latin1").replace("\\", "/"))
        index = {}
        for i in range(n_res):
            name, typ, loc = struct.unpack_from("<8sHI", d, off_res + 14 * i)
            name = name.rstrip(b"\0").decode("latin1").upper()
            index[(name, typ)] = (loc >> 20, loc & 0x3FFF)
        return bifs, index

    def _bif(self, rel: str) -> dict[int, bytes]:
        if rel not in self._bif_cache:
            path = os.path.join(self.root, *rel.split("/"))
            d = open(path, "rb").read()
            sig, ver, n_files, _n_tilesets, off = struct.unpack_from("<4s4sIII", d, 0)
            if sig != b"BIFF":
                raise ValueError(f"{rel}: not an uncompressed BIFF V1 archive ({sig!r})")
            files = {}
            for i in range(n_files):
                loc, o, size, _t, _u = struct.unpack_from("<IIIHH", d, off + 16 * i)
                files[loc & 0x3FFF] = d[o:o + size]
            self._bif_cache[rel] = files
        return self._bif_cache[rel]

    def names(self, typ: int):
        return sorted(n for (n, t) in self.index if t == typ)

    def bif_of(self, name: str, typ: int) -> str:
        return self.bifs[self.index[(name.upper(), typ)][0]]

    def read(self, name: str, typ: int) -> bytes:
        name = name.upper()
        ov = os.path.join(self.root, "override", f"{name}.{EXT.get(typ, 'bin')}")
        if os.path.isfile(ov):
            return open(ov, "rb").read()
        if (name, typ) not in self.index:
            raise KeyError(f"{name}.{EXT.get(typ, typ)} is not in chitin.key")
        bif_i, file_i = self.index[(name, typ)]
        return self._bif(self.bifs[bif_i])[file_i]


def read_tlk(path: str):
    """Yield (strref, sound_resref, text) for every entry of a TLK V1 file."""
    t = open(path, "rb").read()
    sig, ver, _lang, n, off = struct.unpack_from("<4s4sHII", t, 0)
    if sig != b"TLK " or ver != b"V1  ":
        raise ValueError(f"not a TLK V1 file: {sig!r}")
    for i in range(n):
        _flags, snd, _vol, _pitch, o, length = struct.unpack_from("<H8sIIII", t, 18 + 26 * i)
        yield i, snd.rstrip(b"\0").decode("latin1").upper(), t[off + o:off + o + length].decode("latin1")
