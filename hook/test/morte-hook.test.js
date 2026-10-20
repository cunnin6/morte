// Behavior tests for morte-hook.js and install.js. Run: node --test hook/test
// A fake OpenPets IPC server stands in for the desktop app; audio is muted.
"use strict";
const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const net = require("node:net");
const { spawnSync, spawn } = require("node:child_process");

const HOOK = path.join(__dirname, "..", "morte-hook.js");
const INSTALL = path.join(__dirname, "..", "install.js");
const LINES = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "lines.json"), "utf8"));
const TOKEN = "t".repeat(32);

let tmp, server, received;

function endpointFor(dir) {
  return process.platform === "win32" ? `\\\\.\\pipe\\morte-test-${process.pid}-${Date.now()}` : path.join(dir, "ipc.sock");
}

before(async () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "morte-hook-"));
  received = [];
  const endpoint = endpointFor(tmp);
  server = net.createServer((sock) => {
    let buf = "";
    sock.on("data", (c) => {
      buf += c;
      const nl = buf.indexOf("\n");
      if (nl < 0) return;
      const req = JSON.parse(buf.slice(0, nl));
      received.push(req);
      sock.end(JSON.stringify({ id: req.id, ok: true, result: {} }) + "\n");
    });
  });
  await new Promise((r) => server.listen(endpoint, r));
  fs.writeFileSync(path.join(tmp, "ipc.json"), JSON.stringify({ endpoint, token: TOKEN }));
});

after(() => { server.close(); fs.rmSync(tmp, { recursive: true, force: true }); });

function env(stateName, extra = {}) {
  const state = path.join(tmp, stateName);
  return { ...process.env, OPENPETS_DISCOVERY_FILE: path.join(tmp, "ipc.json"), XDG_STATE_HOME: state, LOCALAPPDATA: state, MORTE_MUTE: "1", ...extra };
}

// Hooks run async, so feed stdin and wait for exit rather than spawnSync (which would block the fake server).
function runHook(payload, stateName) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [HOOK], { env: env(stateName) });
    child.stdin.end(typeof payload === "string" ? payload : JSON.stringify(payload));
    child.on("exit", (code) => resolve(code));
  });
}

async function fire(payload, stateName) {
  const before = received.length;
  const code = await runHook(payload, stateName);
  assert.equal(code, 0, "hook must always exit 0");
  return received.slice(before);
}

test("every bubble line passes OpenPets' message validation", () => {
  const r = spawnSync(process.execPath, [HOOK, "--check"], { encoding: "utf8" });
  assert.equal(r.status, 0, r.stdout);
});

test("events map to the right category, reaction and line pool", async () => {
  const cases = [
    [{ hook_event_name: "UserPromptSubmit" }, "thinking", "thinking"],
    [{ hook_event_name: "PreToolUse", tool_name: "Edit", tool_input: {} }, "editing", "editing"],
    [{ hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command: "vendor/bin/phpunit" } }, "testing", "testing"],
    [{ hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command: "ls -la" } }, "running", "running"],
    [{ hook_event_name: "PreToolUse", tool_name: "AskUserQuestion", tool_input: {} }, "question", "waving"],
    [{ hook_event_name: "PermissionRequest" }, "permission", "waiting"],
    [{ hook_event_name: "Notification", notification_type: "idle_prompt", message: "Claude is waiting for your input" }, "idle", "waving"],
    [{ hook_event_name: "Stop" }, "success", "success"],
    [{ hook_event_name: "StopFailure" }, "error", "error"],
  ];
  for (const [payload, cat, reaction] of cases) {
    const got = await fire(payload, `map-${cat}`);
    assert.equal(got.length, 1, `${payload.hook_event_name}/${payload.tool_name || ""} should speak once`);
    const req = got[0];
    assert.equal(req.method, "pet.say");
    assert.equal(req.token, TOKEN);
    assert.equal(req.params.reaction, reaction);
    assert.ok(LINES[cat].includes(req.params.message), `line should come from the ${cat} pool`);
    assert.equal(req.leaseId, undefined, "no lease: speech targets the default pet");
  }
});

test("tools that aren't edits, shells or questions stay silent", async () => {
  assert.equal((await fire({ hook_event_name: "PreToolUse", tool_name: "Read", tool_input: {} }, "silent")).length, 0);
});

test("cooldowns suppress repeats, and the permission Notification duplicate is dropped", async () => {
  assert.equal((await fire({ hook_event_name: "UserPromptSubmit" }, "cool")).length, 1);
  assert.equal((await fire({ hook_event_name: "UserPromptSubmit" }, "cool")).length, 0);
  assert.equal((await fire({ hook_event_name: "PermissionRequest" }, "cool")).length, 1);
  assert.equal((await fire({ hook_event_name: "Notification", notification_type: "permission_prompt", message: "Claude needs your permission" }, "cool")).length, 0);
});

test("a partial config.json override merges per category instead of replacing the map", async () => {
  const cfg = path.join(tmp, "config.json");
  fs.writeFileSync(cfg, JSON.stringify({ cooldownMs: { success: 600000 } }));
  const run = (payload, state) => new Promise((resolve) => {
    const child = spawn(process.execPath, [HOOK], { env: env(state, { MORTE_CONFIG: cfg }) });
    child.stdin.end(JSON.stringify(payload));
    child.on("exit", () => resolve());
  });
  let n = received.length;
  await run({ hook_event_name: "Stop" }, "cfg"); await run({ hook_event_name: "Stop" }, "cfg");
  assert.equal(received.length - n, 1, "overridden category uses the new cooldown");
  n = received.length;
  await run({ hook_event_name: "StopFailure" }, "cfg");
  assert.equal(received.length - n, 1, "other categories keep their defaults");
});

test("garbage input and a missing app never fail the hook", async () => {
  assert.equal(await runHook("not json", "garbage"), 0);
  assert.equal(await runHook("", "garbage"), 0);
  const r = spawnSync(process.execPath, [HOOK], {
    input: JSON.stringify({ hook_event_name: "Stop" }),
    env: { ...env("noapp"), OPENPETS_DISCOVERY_FILE: path.join(tmp, "missing.json") },
    timeout: 5000,
  });
  assert.equal(r.status, 0);
});

test("installer swaps OpenPets-managed hooks for Morte's, keeps others, and uninstalls cleanly", () => {
  const settings = path.join(tmp, "settings.json");
  const managed = { type: "command", command: 'node "C:/x/cli.js" hook --openpets-managed', timeout: 3, async: true };
  fs.writeFileSync(settings, JSON.stringify({
    model: "opus",
    hooks: {
      PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: "guard.sh" }] }, { hooks: [managed] }],
      Stop: [{ hooks: [managed] }],
    },
  }));
  const install = (...a) => spawnSync(process.execPath, [INSTALL, "--settings", settings, ...a], { encoding: "utf8" });

  assert.equal(install().status, 0);
  install(); // idempotent
  let s = JSON.parse(fs.readFileSync(settings, "utf8"));
  assert.equal(s.model, "opus");
  for (const ev of ["UserPromptSubmit", "PreToolUse", "PermissionRequest", "Notification", "Stop", "StopFailure"]) {
    const cmds = s.hooks[ev].flatMap((m) => m.hooks.map((h) => h.command));
    assert.equal(cmds.filter((c) => c.includes("morte-hook.js")).length, 1, `${ev}: exactly one Morte hook`);
    assert.ok(!cmds.some((c) => c.includes("--openpets-managed")), `${ev}: managed hook removed`);
  }
  assert.ok(s.hooks.PreToolUse.some((m) => m.matcher === "Bash" && m.hooks[0].command === "guard.sh"), "unrelated hook kept");

  assert.equal(install("--uninstall").status, 0);
  s = JSON.parse(fs.readFileSync(settings, "utf8"));
  assert.deepEqual(Object.keys(s.hooks), ["PreToolUse"]);
  assert.ok(fs.readdirSync(tmp).some((f) => f.startsWith("settings.json.morte-backup-")), "backup written");
});
