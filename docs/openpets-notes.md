# OpenPets: what this project relies on

Facts about OpenPets that the shipped pieces depend on, with where they come
from. OpenPets moves fast: re-check the source before building on any of this.

- Repo: https://github.com/OpenPetsHQ/openpets (docs: https://docs.openpets.dev)
- Last checked against: desktop v4.1.0 (Oct 2026), the first release with
  `gazeAnchor` support (v4.0.1 predates it).

## Pet packages

- Package = `pet.json` + `spritesheet.webp`. Pet id must match
  `^[a-z0-9][a-z0-9_-]{0,63}$`, must equal its folder name and can't be
  `builtin`. `apps/desktop/src/codex-pets-core.ts` → `validateCodexPetMetadata`.
- V1 atlas: 8×9 cells of 192×208. V2: `"spriteVersionNumber": 2` and exactly
  1536×2288 (8×11), alpha WebP, single image, else the import is rejected.
  V2 neutral pose is row 0, col 6; rows 9–10 are 16 clockwise look directions
  starting at screen-up. (docs/pets.md, "Codex sprite versions")
- V2 idle shows the static neutral cell (plus gaze), not the row-0 animation.
- Gaze: angle from an anchor to the cursor, quantized into 22.5° sectors, 24 px
  dead zone, reset to neutral ~1.2 s after the cursor stops. Suspended during
  reactions, movement, dragging and plugin sprite overrides.
  `pet-window-gaze.ts`, `codex-pets-core.ts` (`codexV2Gaze*`).
- `gazeAnchor: {x, y}` (optional, finite, each in [0, 1], frame-relative from
  top-left, before horizontal flip). Default without it: bottom-center of the
  pet window. Added by PR #249 (issue #247), merged into `main` as `6a855e5`
  with the scale-override follow-up. Unknown `pet.json` fields are ignored by
  older builds, so shipping the field early is harmless.
- Importing rewrites `pet.json` through validation, so a build that doesn't know
  a field drops it, and the imported copy (`%APPDATA%\@open-pets\desktop\pets\<id>\`)
  is what runs. A pet installed under v4.0.1 therefore keeps no `gazeAnchor` after
  upgrading: reinstall it (`openpets install --from-folder dist\pet-v2\morte`).
- Local install paths: `~/.codex/pets/<id>/` is imported as a "Codex pet";
  `openpets install --from-folder <dir>` / `--from-zip <zip>` through the
  running app.

## Talking to the running app (local IPC)

- Discovery file: Windows `%APPDATA%\OpenPets\runtime\ipc.json`. Fields:
  `protocol`, `protocolVersion` (1), `endpoint` (Windows: `\\.\pipe\openpets-…`),
  `token` (16–256 chars), `appVersion`, `pid`, `platform`.
  `packages/client/src/discovery.ts`.
- Request: one JSON line `{id, version: 1, token, method, params}`; response one
  JSON line `{id, ok, result | error: {code, message}}`.
  `packages/client/src/index.ts` → `sendRequest`.
- Methods include `status`, `pet.react`, `pet.say`, `lease.acquire`, ….
  `pet.say` without a `leaseId` goes to the default pet
  (`apps/desktop/src/capture-session.ts` → `sayOnPet`).
- `pet.say` message rules: `validateSayMessage` in
  `apps/desktop/src/local-ipc-protocol.ts` (mirrored in `hook/morte-hook.js`).
- Reactions: `idle thinking working editing running testing waiting waving
  success error celebrating` (`packages/client/src/protocol.ts`). A bare
  reaction gets a random generic line from `apps/desktop/src/reaction-messages.ts`.

## Plugins (what the idle plugin relies on)

Sources: `packages/sdk/src/index.ts`, `apps/desktop/src/plugin-*.ts`, `plugins/community/openpets.walkabout`.

- Manifest `openpets.plugin.json` (`manifestVersion` 3), single-file `entry`
  (`export function register(OpenPetsPlugin)`), no sibling imports. Load locally via
  Plugins → Developer Mode → "Load unpacked plugin folder" (watched, reloads).
- Assets: `sprites` = WebP strip, 1–16 frames, frame 32–512 px, 100–4000 ms, <= 5 MB,
  declared `{path, frameWidth, frameHeight, frames, durationMs}`; `sounds` = ogg/mp3/wav
  <= 1 MB. `plugin-manifest.ts`.
- `ctx.pet.setAnimation({sprite, loop, fps})` overrides the pet with the strip, drawn as
  square frames (frame = strip height) bottom-center. The only way back is
  `setAnimation("idle")` (or another reaction), which makes the desktop show a random
  generic reaction bubble (`default-pet-controller.ts`, `reaction-messages.ts`).
  `plugin-pet-registry.ts`, `pet-preload.cjs`.
- `ctx.pet.react(r, {showMessage: false})` suppresses that generic bubble but does not
  clear a sprite override.
- Movement (`pet:move`): `wander`, `moveBy`, `moveTo`, `followCursor({enabled, lag})`.
  Following moves `1 - lag` of the gap to the cursor per host tick (`pet-motion-engine.ts`), so a higher lag is slower.
- A non-looping sprite strip returns to frame 0 when it ends (the CSS animation has no fill-mode, `pet-preload.cjs`).
- Events (`events`): `idle:enter` / `idle:exit` come from `powerMonitor.getSystemIdleTime()` with a
  fixed 120 s threshold, polled every 15 s; also `screen:locked` / `screen:unlocked`. No keyboard, mouse or
  cursor-position events exist for plugins. `plugin-events-source.ts`.
- Right-click menu (`commands`): `ctx.ui.menu.setItems([{id, title, checked}])` (max 16 items) and `onSelect`.
  Plugin config has no API for writing; the persistent plugin state goes in `ctx.storage` (`storage`).
  `plugin-sdk-ui.ts`, `plugin-sdk-quotas.ts`.
- Config schema types include `select`, `multiSelect`, `number`, `boolean` (`plugin-manifest.ts`).
- `agent:activity` event `{kind, reaction, active, petId, surface}`: published by
  `recordOpenPetsActivity` for every `pet.say` / `pet.react`, from IPC clients and from
  plugins alike. External IPC calls without a lease give `surface: "default"` and the
  real default pet id (not the string `"default"`).

## Claude Code integration (the part the Morte hook replaces)

- OpenPets installs Claude Code hooks on `UserPromptSubmit`, `PreToolUse`,
  `PermissionRequest`, `Notification`, `Stop`, `StopFailure`, each a command
  containing the marker `--openpets-managed`, `timeout: 3`, `async: true`.
  `packages/claude/src/hook-settings.ts`.
- Their speech pools are hardcoded in `packages/agent-events/src/index.ts`.
- MCP server (`npx @open-pets/cli mcp`): tools `openpets_status`,
  `openpets_react`, `openpets_say` (≤ 140 chars, same content rules).
  `packages/mcp/src/server.ts`, `tools.ts`. Not used by this project.
