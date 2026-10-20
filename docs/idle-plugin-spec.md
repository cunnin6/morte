# Idle plugin spec: `plugin/` (Morte Idle, `morte.idle`)

An OpenPets plugin (SDK v3, JavaScript) that gives Morte a life of his own when
nobody is talking to him and tunes it to what the *user* is doing. Source:
`plugin/index.js`, `plugin/openpets.plugin.json`, `plugin/ambient.json`,
`plugin/moods.json`. Built into a loadable folder by `pipeline/build_plugin.py`.


## Why a plugin

The hook talks to OpenPets over local IPC, which offers `pet.say` / `pet.react`
only. Moving the pet, following the cursor, playing a custom animation and
playing a sound all live in the plugin SDK (`ctx.pet.*`, `ctx.audio`), so the
idle behavior has to be a plugin. The hook is unchanged and still owns
everything Claude Code does.

## Computer states (what he can sense)

The plugin cannot see keystrokes, clicks or cursor position. The SDK exposes only
system idle time (OpenPets `idle:enter` / `idle:exit`: `powerMonitor` idle time with a
fixed 120 s threshold, polled every 15 s; `plugin-events-source.ts`) and
`screen:locked` / `screen:unlocked`.

| State | Entered when | Left when |
|---|---|---|
| Working | plugin start; `idle:exit` (within ~15 s of input); `screen:unlocked` | `idle:enter`, `screen:locked` |
| Idle | `idle:enter` (2-2.25 min without input) | `idle:exit`; or Away |
| Away | `screen:locked`, or `awayAfterMin` (default 10) minutes after `idle:enter` | `idle:exit`, `screen:unlocked` |

Away is total silence: no actions, no sound, no timer; a running action is cut short
(waits are sliced to 500 ms so it notices) and says nothing afterward. A blanked
monitor is not observable, so it is covered by the Away timer. Suspend/resume emit no
plugin event; timers do not run while asleep, and the next idle poll corrects the
state after wake up.

## Moods

A mood is a set of behaviors plus its own bubble lines, quips and clips.

| Mood | Feel | Default behaviours | Pace |
|---|---|---|---|
| Bored | complains nobody is around | roam, spin, trick, quip, bark | 1× |
| Engaged | nosy: the user is doing something | follow, quip, bark, trick, spin | 0.7× (more often) |
| Contemplative | quiet company | shift, playdead, contemplate | 1.5× (less often) |

Each state maps to a mood (`idleMood`, `workingMood`: a mood or `off`). Defaults:
Idle → Bored, Working → Engaged. Away has no mood. A mood override (`mood`:
`auto` | a mood | `off`) replaces the mapping; it never overrides Away.

When the mood changes, he drops what he is doing and acts again 2.5–6 s later (so he
reacts quickly once the user starts working); otherwise the next action comes after the
pace interval (below). The first action after start comes 3–8 s in.

Every N s (pace "lively" 15–40 s, "relaxed" 30–90 s, "sleepy" 60–180 s, times the
mood's multiplier) he picks one allowed behavior by weight (`moods.json`), never the
same one twice in a row. Skipped (schedule kept) while the pet is hidden or dragged.

## Behaviours

| Behaviour | What it does |
|---|---|
| roam | 2-4 `wander` hops of 140-320 px, 1.2-2.2 s each (the host clamps to the work area) |
| follow | `followCursor` with lag 0.9 (`FOLLOW_LAG`; the host moves `1 - lag` of the gap per tick, so higher is slower) for 6-12 s ("lemme see that"), then off |
| quip | wave gesture without a generic bubble, then a bubble from the mood's lines; 50 % also a bark |
| bark | wave gesture and one clip from the mood's clip set |
| spin | the `spin` strip twice, then a mood quip (40 % with a bark) |
| trick | one of `tumble`, `flourish`, `pratfall` twice, then a mood quip (40 % with a bark) |
| playdead | `fall` strip, then the one-frame `dead` pose held 4-9 s, then `getup`, then a mood quip |
| shift | 4 or 6 slow `moveBy` sways of 40-70 px (1.4 s each), then back to the start; silent |
| contemplate | one bubble from the contemplative lines; no gesture, no sound |

A bark (including the optional ones inside quip, spin, trick) needs the global
`sound` switch on **and** `bark` among the mood's allowed behaviors, so a mood
without `bark` is silent. Contemplative has no clip set at all.

## Configuration

Live, in the OpenPets control panel (`configSchema`):

| Key | Default | |
|---|---|---|
| `idleMood`, `workingMood` | bored, engaged | mood per state (bored, engaged, contemplative, off) |
| `awayAfterMin` | 10 | idle minutes (after the 2 min threshold) until Away; 1-240 |
| `mood` | auto | override: auto, a mood, or off |
| `behavioursBored`, `behavioursEngaged`, `behavioursContemplative` | see Moods | multi-select of the nine behaviours allowed in each mood |
| `pace` | lively | lively, relaxed, sleepy |
| `sound` | on | global mute for every clip |
| `pauseWhenBusy` | on | stay put while an agent drives him (below) |

`DEFAULT_BEHAVIOURS` in `index.js` and the manifest defaults must match (a test checks it).

Build-time, in `plugin/moods.json`: relative weight of every behavior per mood, and
`paceMul` per mood. Animation recipes: `plugin/ambient.json`. Edit, then
`python pipeline/build_plugin.py --data-only`.

## Right-click menu

`ctx.ui.menu.setItems` / `onSelect` (permission `commands`): "Mood: automatic (idle:
Bored)" (the label shows the current state and mood), Mood: Bored / Engaged /
Contemplative, "Mood: quiet (off)", "Barks and sound", "Pause while Claude is
working". Checked items show the current choice and the menu is refreshed whenever the
state or config changes.

The SDK has no config write, so menu choices are saved as overrides in `ctx.storage`
(`prefs`, permission `storage`) on top of the control-panel config and survive
restarts. Changing a setting in the control panel drops the override for that key, so
the newest change wins. Limitation: the control panel does not show values set from
the menu.

## Pausing while Claude Code is driving

The host emits `agent:activity` (`{kind, reaction, active, petId, surface}`)
whenever anything calls `pet.say` / `pet.react`, including the hook's IPC calls
(`recordOpenPetsActivity`, `local-ipc-request-handler.ts`). `active` is true for
anything but kind `"idle"`. On an active pulse the plugin stops what it is doing
(following off, sprite cleared) and does nothing for 45 s (`RESUME_AFTER_AGENT_MS`);
each further pulse restarts that 45 s. In Away or a mood-less state a pulse starts no
timer.

- Filter: `surface` must be `default`. Walkabout also requires `petId ==
  "default"`, which would drop our pulses (the host sends the real pet id,
  `morte`), so this plugin does not.
- The plugin's own `speak` / `react` / `setAnimation` calls echo back as pulses.
  They are ignored for 800 ms (`SELF_ECHO_MS`) after each own call.
- Config `pauseWhenBusy` (default on) turns the pause off.

## Animations (sprite strips)

A plugin cannot play rows of the pet atlas; `setAnimation({sprite})` takes a
strip declared in the plugin manifest: one WebP row of square frames, 1–16
frames, frame 32–512 px, 100–4000 ms, ≤ 5 MB. The host draws it at natural size,
bottom and centered, at 1–30 fps. `build_plugin.py` builds the strips from the same
game frames and the same 3× / anchor rules as the pet (`docs/pet-spec.md`),
with each 192×208 cell centred in a 208×208 frame.

| Name | Frames @ fps | Source |
|---|---|---|
| spin | 16 @ 16 | the 16 gaze cells in order: one full clockwise turn |
| tumble | 12 @ 12 | `CHIT` c0 (the hit spin); also hops: `moveBy` -80 px, strip, +80 px |
| flourish | 11 @ 10 | `CSF1` c0 frames 3-13 (head-turn flourish) |
| pratfall | 16 @ 8 | `CDFB` c0 ×8 (falls) then `CGUP` c0 ×8 (gets back up) |
| fall | 8 @ 8 | the `CDFB` half of pratfall (playdead) |
| dead | 1 @ 8 | `CDFB` c0 last frame, the pose held on the ground (playdead) |
| getup | 8 @ 8 | the `CGUP` half of pratfall (playdead) |

Why `dead` is its own strip: a non-looping strip returns to frame 0 when it ends
(`pet-preload.cjs`: the CSS animation has no fill-mode), so the held pose is a
separate one-frame strip swapped in just before `fall` would restart (at 95 % of its
duration).

**Clearing a sprite:** the only way to drop a sprite override is
`setAnimation("idle")`, and OpenPets answers that with a random generic bubble
("Ready", "Standing by"). The plugin follows it at once with a Morte quip, so the
generic line is replaced. When the animation is cut short (agent pulse, Away, mood
change) there is no quip; a generic bubble may flash until the agent's own bubble lands.

**Bubble lifetime:** every bubble is spoken with `durationMs: BUBBLE_MS` (3500). A
`react` or `setAnimation("idle")` starts a ~4 s transient display in OpenPets; when it
expires the host rebuilds the pet's DOM, which replays the bubble's pop-in animation.
A bubble that outlives it appears to pop twice.

## Data and assets

| What | Where | Committed |
|---|---|---|
| Idle lines per mood | `hook/lines.json` → `ambientBored`, `ambientEngaged`, `ambientContemplative` | yes (original text; checked by `npm run check`) |
| Quips (after spin/trick/playdead) | `hook/lines.json` → `ambientQuipsBored`, `…Engaged`, `…Contemplative` | yes |
| Clip selection per mood | `hook/clips.json` → `clips.ambientBored`, `clips.ambientEngaged` (Contemplative has none) | yes (resrefs) |
| Weights, pace multipliers | `plugin/moods.json` | yes |
| Animation recipes | `plugin/ambient.json` | yes |
| Clips, sprite strips | `dist/plugin/morte-idle/assets/` | no (game-derived) |

Plugin entry points are single files, so `build_plugin.py` injects the data into
`index.js` by replacing the `"__AMBIENT__"` literal. Sound names are the
lower-cased resref (`mrt042`), sprite names the animation name. The clip sets were
picked from the existing 32 clips by their game labels; nobody has listened to them
(vet them with `hook/audition.html`, which shows the Bored and Engaged sets and
their lines; the Contemplative lines are only in `lines.json`).

## Permissions

`pet:speak`, `pet:move`, `pet:animate` (sprites), `pet:reaction` (gesture, clearing
sprites), `pets:read` (`getState`: hidden/dragging), `audio`, `events` (agent
activity, idle and lock events), `status`, `commands` (menu), `storage` (menu overrides).

## Build, load, test

```
python pipeline/extract_voice.py --game "<gamepath>"      # the mood clips must be in hook/clips/
python pipeline/build_plugin.py  --game "<gamepath>"      # full build -> dist/plugin/morte-idle/, dist/plugin/preview-idle.png
python pipeline/build_plugin.py  --data-only          # after editing lines, moods.json, clip sets: reuses the strips
```

In OpenPets: Plugins → Developer Mode → "Load unpacked plugin folder" →
`dist\plugin\morte-idle`. It watches the folder and reloads on rebuild. Look at
`dist/plugin/preview-idle.png` after a full build (rows: spin, tumble, flourish,
pratfall, fall, dead, getup). `npm test` runs `plugin/test/idle.test.mjs` (fake `ctx`,
fake clock). The manifest was also checked against OpenPets' `validatePluginManifest`.

