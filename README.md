# Morte

Morte from *Planescape: Torment* as an [OpenPets](https://docs.openpets.dev)
desktop pet, with a Claude Code hook that gives him a voice.

Everything game-derived (sprites, voice clips) is built locally from your own
copy of *Planescape: Torment: Enhanced Edition* and is never committed.

## Quick start (Windows)

```
pip install -r pipeline/requirements.txt          # plus ffmpeg on PATH

python pipeline/build_pet.py --game "<gamepath>"
openpets install --from-folder dist\pet-v2\morte

python pipeline/extract_voice.py --game "<gamepath>"
node hook/install.js
node hook/morte-hook.js --test success

python pipeline/build_plugin.py --game "<gamepath>"
# OpenPets: Plugins -> Developer Mode -> Load unpacked plugin folder -> dist\plugin\morte-idle
```

Open `hook/audition.html` to hear every clip and read every line.

## Docs

- `AGENTS.md`: how the project is put together, rules, build, test, deploy
- `docs/pet-spec.md`: the spritesheet
- `docs/voice-hook-spec.md`: the Claude Code hook
- `docs/idle-plugin-spec.md`: the idle plugin (moods, roam, follow, mutter, spin, play dead)
- `docs/openpets-notes.md`: the OpenPets contracts this depends on

## Notes

The plugin will edit `~/.claude/settings.json` to expose the voice hook to Claude Code.
It does make a backup and provides a restore option, but change that behavior in `hook/install.json` if you don't want it to.

The `hook/clips.json` is a curated file where you decide which clips to use for the voice hooks.

## Legal

This is an unofficial, non-commercial fan project. It is not affiliated with
or endorsed by Beamdog, Wizards of the Coast, Hasbro, or the makers of
OpenPets.

*Planescape: Torment* and Morte are © of their respective owners. **This
repository contains no game assets**: no sprites, audio, text, or data from the
game. It holds only code, a list of game resource names, and original writing.
To use it, you must own *Planescape: Torment: Enhanced Edition* and build the
pet and voice clips locally from your own installation with the pipeline above.
The output is for your private use. Don't redistribute it, and don't upload
the built pet to any catalog. Extracting the assets does not circumvent any
DRM copyright protections.

The code and original text (including the bubble lines in `hook/lines.json`)
are released under the [MIT License](LICENSE). That license does not extend to
anything derived from the game.
