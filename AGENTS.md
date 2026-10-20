# AGENTS.md

Guidance for AI agents (and humans) working in this repo. Read this first, then
the spec for whatever you're touching in `docs/`.

## What this is

Morte, the floating skull from *Planescape: Torment*, as a desktop pet for
[OpenPets](https://openpets.dev), built from the game files,
plus a Claude Code hook that gives him a voice when Claude Code works. Personal
fan project, public under the MIT license (code and original text only;
see `LICENSE` and the README's Legal section).

## What is shipped

| Component | What it does | Source | Spec |
|---|---|---|---|
| Pet (V2) | 1536×2288 OpenPets atlas from Morte's game sprites: 9 animation rows, 16 cursor-gaze cells, `gazeAnchor` on the skull. This is the visible part. | `pipeline/build_pet.py` | `docs/pet-spec.md` |
| Pet (V1) | Alternative build; same art, 9 rows, animated idle, no gaze. | `pipeline/build_pet.py` | `docs/pet-spec.md` |
| Voice clips | 32 of Morte's game barks, decoded and peak-normalised | `pipeline/extract_voice.py` | `docs/voice-hook-spec.md` |
| Claude Code voice hook | Claude Code events → Morte bubble (original lines) + game bark; replaces OpenPets' managed Claude hooks | `hook/` | `docs/voice-hook-spec.md` |
| Idle plugin (Morte Idle) v2.0 | OpenPets plugin, this is pet's behaviour. Three moods (Bored, Engaged, Contemplative) chosen by computer state (working / idle / away), right-click overrideable; nine behaviours total, configurable per mood in the control panel; pauses while Claude Code drives him. | `plugin/`, `pipeline/build_plugin.py` | `docs/idle-plugin-spec.md` |

Anything not in this table is not built. Don't describe planned work as existing.

## Hard rules

1. **Never commit or publish game-derived assets.** Spritesheets, preview
   images, WAV/ACM clips, BAM/BIF/TLK data and anything decoded from them are
   Beamdog/WotC art. They are produced locally by the pipeline into gitignored
   paths (`dist/`, `hook/clips/`, `hook/clips.meta.json`, `hook/audition.html`). **Don't** remove those
   `.gitignore` entries, **don't** upload the pet to the OpenPets catalog, **don't**
   publish artifacts containing them. The repo holds only code, curated
   selections (resref lists, labels) and docs.
2. **Bubble text is original writing** in Morte's voice. **Don't** paste game
   dialogue into `lines.json`; his real voice comes only from the local clips.
3. **The game install is the source of truth.** Every asset must be
   reproducible from it with the pipeline. If you hand-edit an output, the
   change is lost. Change the pipeline instead.
4. **Every bubble line must pass OpenPets' message validation.** Run
   `npm run check` (also covered by `npm test`).
5. **The hook must never fail or block Claude Code:** always exit 0, bounded
   timeouts, no thrown errors on bad input or a missing app.
6. **Spec docs move with the code.** Changing a number in `build_pet.py`, a
   mapping in the hook, or a category/clip means updating `docs/` in the same
   commit.

## Repo layout

```
AGENTS.md                this file
README.md                human quick start
package.json             npm test / npm run check (hook)
pipeline/                Python: game files -> pet packages, voice clips
  ie.py                  chitin.key / BIF / dialog.tlk reader (override/ first)
  bam.py                 BAM V1 / BAMC decoder
  build_pet.py           pet build (V2 + V1, zips, previews, self-checks)
  extract_voice.py       clip extraction (+ --list of all Morte clips)
  build_plugin.py        idle plugin build (sprite strips, clips, injected data)
  requirements.txt
plugin/                  OpenPets idle plugin source (index.js, manifest, moods.json, ambient.json, test/)
hook/                    Claude Code voice hook (Node >= 18, no deps)
  morte-hook.js          the hook
  install.js             swaps OpenPets-managed Claude hooks for this one
  lines.json             bubble lines per category (committed, original text)
  clips.json             clip selection per category (committed)
  test/                  node:test suite with a fake OpenPets server
  clips/, clips.meta.json, audition.html  generated (labels, durations), gitignored
docs/
  pet-spec.md            atlas, row mapping, scale/anchor/clipping, gaze
  voice-hook-spec.md     event mapping, lines/clips rules, IPC, config, state
  idle-plugin-spec.md    states, moods, behaviours, menu, pause rule, sprite strips, plugin build/load
  openpets-notes.md      OpenPets contracts relied on, with source refs
dist/                    build output, gitignored
```

## Environment

Adjust `--game` location to yours.

| What | Where |
|---|---|
| Game (PS:T Enhanced Edition, GOG) | `D:\Galaxy\Planescape Torment - Enhanced Edition` |
| Installed pet | `%USERPROFILE%\.codex\pets\morte\` |
| Claude Code settings (hooks) | `%USERPROFILE%\.claude\settings.json` |
| Hook state / debug log | `%LOCALAPPDATA%\MorteVoice\` |
| OpenPets IPC discovery | `%APPDATA%\OpenPets\runtime\ipc.json` |

Prerequisites: Python ≥ 3.10 with `pip install -r pipeline/requirements.txt`
(Pillow with WebP, numpy); `ffmpeg` on PATH for `extract_voice.py` (its `acm`
demuxer decodes the game audio); Node ≥ 18 for the hook.

Only the game files below are read. EE install preferred; the classic
release's multi-CD layout is untested.

| File | Used by |
|---|---|
| `chitin.key` | both |
| `data/CA_mrt.bif` | `build_pet.py` |
| `data/voice.bif`, `data/sound.bif`, `lang/en_US/dialog.tlk` | `extract_voice.py` |

## Build

```
python pipeline/build_pet.py --game <gamepath>
python pipeline/extract_voice.py --game <gamepath>
python pipeline/extract_voice.py --game <gamepath> --list  # browse every Morte clip with its label
python pipeline/build_plugin.py --game <gamepath>          # idle plugin -> dist/plugin/morte-idle/ (after extract_voice.py)
python pipeline/build_plugin.py --data-only                # re-inject lines / moods / clip sets, keep the sprite strips
```

`build_pet.py` writes `dist/pet-v2/morte/`, `dist/pet-v1/morte/`,
`dist/morte-v{1,2}.zip` and `dist/preview-v{1,2}.png`, and asserts the
OpenPets import checks (exact size, alpha, single-frame WebP). "31 clipped
cells" is expected (see `docs/pet-spec.md`, clipping budget).
`extract_voice.py` writes `hook/clips/*.wav`, writes labels/durations to
`hook/clips.meta.json` and regenerates `hook/audition.html`. `build_plugin.py` writes
`dist/plugin/morte-idle/` and `dist/plugin/preview-idle.png`; look at the preview
before shipping.

Both are deterministic for the same game files: pixel-identical sheets, and
byte-identical clips with the same ffmpeg version. After any pipeline change, look at
`dist/preview-v2.png` before shipping.

## Test

```
npm test          # hook behaviour (event mapping, cooldowns, dedupe, config merge, failure paths, installer) + idle plugin (fake ctx)
npm run check     # every bubble line passes OpenPets validation
node hook/morte-hook.js --test <category>   # live: real bubble + bark on the running app
```

There's no automated test for the pipeline beyond its built-in assertions;
verify by previewing and by comparing against the previous build.

## Deploy

**Pet:** build, then either copy `dist/pet-v2/morte/pet.json` and
`spritesheet.webp` into `%USERPROFILE%\.codex\pets\morte\`, or run
`openpets install --from-folder dist\pet-v2\morte` with OpenPets running.
Restart OpenPets or re-scan pets. After upgrading OpenPets, reinstall: the
imported copy in `%APPDATA%\@open-pets\desktop\pets\morte\` is what runs, and an
older build strips `pet.json` fields it doesn't know (e.g. `gazeAnchor`).

**Voice hook:** run `extract_voice.py` so `hook/clips/` exists, then
`node hook/install.js`. It backs up `settings.json`, removes OpenPets-managed
Claude hooks and any previous Morte hook entry, and points six events at this
repo's `hook/morte-hook.js`. Restart Claude Code sessions. Undo with
`node hook/install.js --uninstall`, then `openpets configure --agent claude`
for the stock hooks. Re-run `install.js` after any `openpets configure`, which
re-adds the managed hooks.

**Idle plugin:** build it (above), then in OpenPets: Plugins -> Developer Mode ->
"Load unpacked plugin folder" -> `dist\plugin\morte-idle`. OpenPets watches the
folder and reloads on rebuild. Pace, barks and pause-when-busy are in the
plugin's settings.


## Decisions that drive development

- **EE, not classic**: same Morte art; EE has a single `data/` layout.
- **Integer 3× nearest-neighbour**, not smooth or AI upscaling: faithful pixels;
  costs on-screen size.
- **`gazeAnchor` (0.5, 0.25)**: measured skull centre;
- **Hook replaces managed hooks** instead of adding to them: their pools and the
  desktop's generic reaction lines can't be changed.
- **Only `AskUserQuestion` is a "question"**; a reply ending in "?" still counts
  as "success".
